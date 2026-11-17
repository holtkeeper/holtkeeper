import { recordMetrics } from '@holtkeeper/analyzer'
import { auditAnalysis, auditAnalyzer } from '@holtkeeper/analyzers'
import { definedPackages, depgraphDataSchema } from '@holtkeeper/depgraph'
import type { RepoRef } from '@holtkeeper/forge'
import { dailyLimitsOf, enqueueUnique } from '@holtkeeper/jobs'
import type { AnalysisHead, KvStore } from '@holtkeeper/store'
import { auditReportSchema } from '@holtkeeper/vuln'
import {
  type Inventory,
  type VulnRecordCache,
  fixableKeys,
  indexAuditReport,
  inventoryOf,
  kvRecordCache,
  matchPackages,
  sameAuditState,
} from '@holtkeeper/vuln-index'
import { type OsvClient, osvClient } from '@holtkeeper/vuln-osv'
import { z } from 'zod'

import { type ServerDeps, repoKey } from './context.ts'
import { automaticJobReady, scopedAnalyzerOptions } from './jobs.ts'
import type { LeaderDuty } from './leader.ts'
import { analyzerOffFor } from './repo-analyzers.ts'

/** The `KvStore` key of the index's own state. */
const STATE_KEY = 'vuln-index:state'
/** Every repository is matched again this often, so new and changed advisories reach it. */
const FULL_INTERVAL_MS = 3_600_000
/** An unchanged audit is written again after this long, so the record shows the last check. */
const HEARTBEAT_MS = 86_400_000
/** How often the duty looks for new dependency graphs. */
const TICK_MS = 60_000
/** Pause after a failed run before the next try. */
const RETRY_MS = 10 * 60_000
/** `actor` of the audit records the index writes. */
export const VULN_INDEX_ACTOR = 'system:vuln-index'

const repoStateSchema = z.object({
  /** The `depgraph` record the repository was last matched from. */
  depgraph: z.string(),
  /** Packages the repository defines, as `<ecosystem>:<name>`; internal to the fleet. Stored as jsonb, so no NUL bytes. */
  defines: z.array(z.string()).default([]),
  /** `fixableKeys` of the last match; fix runs are queued for keys not in here. */
  fixable: z.array(z.string()).default([]),
})

const stateSchema = z.object({
  fullAt: z.string().optional(),
  repos: z.record(z.string(), repoStateSchema).default({}),
})

type IndexState = z.output<typeof stateSchema>
type RepoState = z.output<typeof repoStateSchema>

/** What `runVulnIndex` needs. */
export type VulnIndexDeps = Pick<ServerDeps, 'config' | 'store' | 'analyzers' | 'now'>

/** Seams of `runVulnIndex`; defaults reach the public OSV API and cache in `store.kv`. */
export interface VulnIndexOptions {
  client?: OsvClient
  cache?: VulnRecordCache
  /** Match every repository, whenever the last full run was. */
  full?: boolean
  log?: (line: string) => void
  signal?: AbortSignal
}

/** What one run did. */
export interface VulnIndexSummary {
  full: boolean
  /** Repositories matched. */
  repos: number
  /** Distinct package versions looked up. */
  packages: number
  /** Audit records written. */
  written: number
  /** Fix runs queued. */
  queued: number
  /** Repositories left without a record, with the reason. */
  skipped: { repo: string; reason: string }[]
}

async function readState(kv: Pick<KvStore, 'get'>): Promise<IndexState> {
  return stateSchema.safeParse(await kv.get(STATE_KEY)).data ?? { repos: {} }
}

// Ecosystem names never contain ':', so the key is unambiguous; Postgres jsonb rejects '\0'.
const defineKey = (ecosystem: string, name: string) => `${ecosystem}:${name}`

/** `isInternal` over the packages repositories define; Go also matches paths inside a module. */
function internalMatcher(defines: Iterable<string>) {
  const known = new Set(defines)
  return (ecosystem: string, name: string) => {
    if (known.has(defineKey(ecosystem, name))) return true
    if (ecosystem !== 'Go') return false
    for (let end = name.lastIndexOf('/'); end > 0; end = name.lastIndexOf('/', end - 1))
      if (known.has(defineKey(ecosystem, name.slice(0, end)))) return true
    return false
  }
}

interface Loaded {
  head: AnalysisHead
  repo: RepoRef
  key: string
  inventory?: Inventory
  defines: string[]
  /** Why the repository's graph could not be read. */
  unreadable?: string
}

async function loadRepo(deps: VulnIndexDeps, head: AnalysisHead): Promise<Loaded> {
  const base = { head, repo: head.repo, key: repoKey(head.repo) }
  const record = await deps.store.analyses.get(head.id)
  const parsed = depgraphDataSchema.safeParse(record?.data)
  if (!parsed.success)
    return { ...base, defines: [], unreadable: 'the dependency graph is not valid' }
  return {
    ...base,
    inventory: inventoryOf(parsed.data),
    defines: definedPackages(parsed.data).map((pkg) => defineKey(pkg.ecosystem, pkg.name)),
  }
}

/**
 * One run of the fleet vulnerability index. It matches the npm and Go packages of the newest
 * `depgraph` record of each repository against OSV in one batch: every repository on a full run
 * (`full`, the first run, or when the last full run is `FULL_INTERVAL_MS` old), otherwise only
 * repositories whose newest graph changed since the last run. For each matched repository it
 * applies the repository's `audit.allowlist` and traits and stores an `audit` record (and an audit
 * run) when the state differs from the newest audit record, or that record is a day old (only the
 * record then). Where `audit.fix` is on and the match shows something fixable that the last match
 * did not, it queues an `audit` job with trigger `vuln-index`.
 *
 * Repositories whose graph failed to load, has no lockfile the index reads or whose `audit` is
 * turned off get no record. Packages any repository defines are never matched. When OSV fails the
 * run throws and changes nothing. Needs `store.kv`; does nothing without it.
 */
export async function runVulnIndex(
  deps: VulnIndexDeps,
  options: VulnIndexOptions = {},
): Promise<VulnIndexSummary | undefined> {
  const { config, store } = deps
  const { kv } = store
  if (!kv) return undefined
  const log = options.log ?? (() => {})
  const now = deps.now()
  const state = await readState(kv)
  const full =
    options.full === true ||
    state.fullAt === undefined ||
    now.getTime() - Date.parse(state.fullAt) >= FULL_INTERVAL_MS
  const heads = await store.analyses.latestHeads({ kind: 'depgraph' })
  const due = full
    ? heads
    : heads.filter((head) => state.repos[repoKey(head.repo)]?.depgraph !== head.id)
  const summary: VulnIndexSummary = {
    full,
    repos: 0,
    packages: 0,
    written: 0,
    queued: 0,
    skipped: [],
  }
  if (due.length === 0) return summary

  const loaded: Loaded[] = []
  for (const head of due)
    // oxlint-disable-next-line no-await-in-loop -- one graph in memory at a time
    loaded.push(await loadRepo(deps, head))

  const dueKeys = new Set(loaded.map((each) => each.key))
  const live = new Set(heads.map((head) => repoKey(head.repo)))
  const isInternal = internalMatcher([
    ...loaded.flatMap((each) => each.defines),
    ...Object.entries(state.repos)
      .filter(([key]) => !dueKeys.has(key) && live.has(key))
      .flatMap(([, repo]) => repo.defines),
  ])
  for (const each of loaded)
    if (each.inventory)
      each.inventory = {
        ...each.inventory,
        packages: each.inventory.packages.filter((pkg) => !isInternal(pkg.ecosystem, pkg.name)),
      }

  const matched = await matchPackages({
    client: options.client ?? osvClient(),
    cache: options.cache ?? kvRecordCache(kv),
    packages: loaded.flatMap((each) =>
      each.inventory && !each.inventory.problem ? each.inventory.packages : [],
    ),
    ...(options.signal && { signal: options.signal }),
  })
  summary.packages = matched.queried

  const auditJobs = deps.analyzers?.find((analyzer) => analyzer.kind === auditAnalyzer.kind)
  const repos: Record<string, RepoState> = Object.fromEntries(
    Object.entries(state.repos).filter(([key]) => live.has(key)),
  )
  for (const each of loaded) {
    const previous = repos[each.key]
    const keep = (reason: string): void => {
      summary.skipped.push({ repo: each.key, reason })
      repos[each.key] = {
        depgraph: each.head.id,
        defines: each.defines,
        fixable: previous?.fixable ?? [],
      }
    }
    if (each.unreadable || !each.inventory) {
      keep(each.unreadable ?? 'no dependency graph')
      continue
    }
    if (each.inventory.problem) {
      keep(each.inventory.problem)
      continue
    }
    // oxlint-disable-next-line no-await-in-loop -- repositories are written one after another
    if (await analyzerOffFor(store, config, each.repo, auditAnalyzer.kind)) {
      keep('audit is turned off')
      continue
    }
    // oxlint-disable-next-line no-await-in-loop
    const scoped = await scopedAnalyzerOptions(config, store, {
      analyzer: auditAnalyzer.kind,
      repo: each.repo,
    })
    const auditOptions = auditAnalyzer.options.safeParse(scoped ?? {})
    if (!auditOptions.success) {
      keep('the audit settings are not valid')
      continue
    }
    summary.repos += 1
    const report = indexAuditReport({
      packages: each.inventory.packages,
      records: matched.records,
      allowlist: auditOptions.data.allowlist,
      traits: auditOptions.data.traits,
      now,
    })

    // oxlint-disable-next-line no-await-in-loop
    const [latest] = await store.analyses.latest({ repo: each.repo, kind: auditAnalysis.kind })
    const latestReport = auditReportSchema.safeParse(latest?.data).data
    const changed = !latestReport || !sameAuditState(latestReport, report)
    const stale = !latest || now.getTime() - Date.parse(latest.createdAt) >= HEARTBEAT_MS
    if (changed || stale) {
      const createdAt = now.toISOString()
      // oxlint-disable-next-line no-await-in-loop
      const metrics = await recordMetrics(
        store.analyses,
        auditAnalysis,
        { repo: each.repo, createdAt, data: report },
        auditOptions.data,
      )
      // oxlint-disable-next-line no-await-in-loop
      await store.analyses.add({
        repo: each.repo,
        kind: auditAnalysis.kind,
        ...(each.head.sha !== undefined && { sha: each.head.sha }),
        createdAt,
        actor: VULN_INDEX_ACTOR,
        data: report,
        ...(metrics !== undefined && { metrics }),
      })
      if (changed)
        // oxlint-disable-next-line no-await-in-loop
        await store.auditRuns.add({
          repo: each.repo,
          trigger: 'vuln-index',
          startedAt: createdAt,
          finishedAt: createdAt,
          report,
        })
      summary.written += 1
    }

    const fixable = fixableKeys(report)
    const known = new Set(previous?.fixable ?? [])
    const fresh = fixable.filter((key) => !known.has(key))
    if (auditJobs && auditOptions.data.fix && fresh.length) {
      const advisories = [...new Set(fresh.map((key) => key.split('|')[0]))]
      const request = {
        analyzer: auditJobs.kind,
        repo: each.repo,
        trigger: 'vuln-index' as const,
        reason: `fixable advisories: ${advisories.slice(0, 5).join(', ')}${advisories.length > 5 ? ` and ${advisories.length - 5} more` : ''}`,
      }
      // oxlint-disable-next-line no-await-in-loop
      if (await automaticJobReady(config, store, auditJobs, request)) {
        // oxlint-disable-next-line no-await-in-loop
        const { enqueued } = await enqueueUnique(store.jobs, [request], now.toISOString(), {
          dailyLimits: dailyLimitsOf(deps.analyzers ?? []),
        })
        summary.queued += enqueued.length
      }
    }
    repos[each.key] = { depgraph: each.head.id, defines: each.defines, fixable }
  }

  await kv.set(STATE_KEY, {
    ...(full ? { fullAt: now.toISOString() } : state.fullAt ? { fullAt: state.fullAt } : {}),
    repos,
  })
  log(
    `vuln index: ${full ? 'full' : 'changed'} run matched ${summary.repos} repositor${summary.repos === 1 ? 'y' : 'ies'} ` +
      `(${summary.packages} package versions, ${matched.fetched} advisories fetched), ` +
      `${summary.written} record(s) written, ${summary.queued} fix run(s) queued` +
      (summary.skipped.length ? `, ${summary.skipped.length} skipped` : ''),
  )
  return summary
}

/**
 * The leader duty of the vulnerability index: a run every minute that matches repositories with a
 * new dependency graph, and all of them once an hour. After a failed run it waits ten minutes.
 */
export function vulnIndexDuty(
  deps: VulnIndexDeps,
  options: Omit<VulnIndexOptions, 'full' | 'signal'> = {},
): LeaderDuty {
  return () => {
    let running: Promise<unknown> | undefined
    let retryAt = 0
    const controller = new AbortController()
    const run = () => {
      if (Date.now() < retryAt) return
      running ??= runVulnIndex(deps, { ...options, signal: controller.signal })
        .catch((error: unknown) => {
          retryAt = Date.now() + RETRY_MS
          options.log?.(
            `vuln index: run failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
        .finally(() => {
          running = undefined
        })
    }
    run()
    const timer = setInterval(run, TICK_MS)
    return async () => {
      clearInterval(timer)
      controller.abort()
      await running
    }
  }
}
