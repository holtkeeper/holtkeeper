import { recordMetrics } from '@holtkeeper/analyzer'
import { depgraphDataSchema, devOnlyPackages, loadPackageCatalog } from '@holtkeeper/depgraph'
import type { RepoRef } from '@holtkeeper/forge'
import {
  type DepsDevClient,
  type LicenseCache,
  type LicensesData,
  depsDevClient,
  inventoryLicenses,
  kvLicenseCache,
  licensesAnalysis,
  licensesAnalyzer,
  licensesDataSchema,
  lookupLicenses,
  projectLicenseFile,
  sameLicensesState,
} from '@holtkeeper/licenses'
import type { AnalysisHead, KvStore } from '@holtkeeper/store'
import { type Inventory, inventoryOf } from '@holtkeeper/vuln-index'
import { z } from 'zod'

import { type ServerDeps, repoKey } from './context.ts'
import { scopedAnalyzerOptions } from './jobs.ts'
import type { LeaderDuty } from './leader.ts'
import { analyzerOffFor } from './repo-analyzers.ts'

/** The `KvStore` key of the index's own state. */
const STATE_KEY = 'license-index:state'
/** Every repository is judged again this often, so policy and exception changes reach it. */
const FULL_INTERVAL_MS = 3_600_000
/** An unchanged record is written again after this long, so it shows the last check. */
const HEARTBEAT_MS = 86_400_000
/** How often the duty looks for new dependency graphs. */
const TICK_MS = 60_000
/** Pause after a failed run before the next try. */
const RETRY_MS = 10 * 60_000
/** `actor` of the licenses records the index writes. */
export const LICENSE_INDEX_ACTOR = 'system:license-index'

const repoStateSchema = z.object({
  /** The `depgraph` record the repository was last judged from. */
  depgraph: z.string(),
  /** License files at the repository root, read when `depgraph` changed. */
  licenseFiles: z.array(z.string()).optional(),
})

const stateSchema = z.object({
  fullAt: z.string().optional(),
  repos: z.record(z.string(), repoStateSchema).default({}),
})

type IndexState = z.output<typeof stateSchema>
type RepoState = z.output<typeof repoStateSchema>

/** What `runLicenseIndex` needs. */
export type LicenseIndexDeps = Pick<ServerDeps, 'config' | 'store' | 'now'>

/** Seams of `runLicenseIndex`; defaults reach the public deps.dev API and cache in `store.kv`. */
export interface LicenseIndexOptions {
  client?: DepsDevClient
  cache?: LicenseCache
  /** License files at the root of a repository's default branch; default: the forge's `listFiles`. */
  rootFiles?: (repo: RepoRef) => Promise<string[] | undefined>
  /** Judge every repository, whenever the last full run was. */
  full?: boolean
  log?: (line: string) => void
  signal?: AbortSignal
}

/** What one run did. */
export interface LicenseIndexSummary {
  full: boolean
  /** Repositories judged. */
  repos: number
  /** Distinct package versions looked up. */
  packages: number
  /** Versions deps.dev was asked about. */
  fetched: number
  /** Licenses records written. */
  written: number
  /** Repositories left without a record, with the reason. */
  skipped: { repo: string; reason: string }[]
}

async function readState(kv: Pick<KvStore, 'get'>): Promise<IndexState> {
  return stateSchema.safeParse(await kv.get(STATE_KEY)).data ?? { repos: {} }
}

/** Root file names of the default branch through the repository's forge; `undefined` when it cannot list them. */
function forgeRootFiles(deps: LicenseIndexDeps) {
  return async (repo: RepoRef): Promise<string[] | undefined> => {
    const forge = deps.config.forges[repo.forge]?.create()
    if (!forge?.listFiles) return undefined
    const entries = await forge.listFiles(repo.path)
    return entries.filter((entry) => entry.type === 'file').map((entry) => entry.path)
  }
}

interface Loaded {
  head: AnalysisHead
  repo: RepoRef
  key: string
  inventory?: Inventory
  devOnly?: Set<string>
  /** Why the repository's graph could not be read. */
  unreadable?: string
}

const devKey = (ecosystem: string, name: string, version: string) =>
  `${ecosystem}\0${name}\0${version}`

async function loadRepo(deps: LicenseIndexDeps, head: AnalysisHead): Promise<Loaded> {
  const base = { head, repo: head.repo, key: repoKey(head.repo) }
  const record = await deps.store.analyses.get(head.id)
  const parsed = depgraphDataSchema.safeParse(record?.data)
  if (!parsed.success) return { ...base, unreadable: 'the dependency graph is not valid' }
  return {
    ...base,
    inventory: inventoryOf(parsed.data),
    devOnly: new Set(
      devOnlyPackages(parsed.data).map((pkg) =>
        devKey(pkg.ecosystem, pkg.name, pkg.version.replace(/^v/u, '')),
      ),
    ),
  }
}

/**
 * One run of the fleet license index. It reads the npm and Go packages of the newest `depgraph`
 * record of each repository, looks up the licenses of every distinct version once (deps.dev,
 * cached across runs and repositories) and judges them with the repository's `analyzers.licenses`
 * settings: every repository on a full run (`full`, the first run, or when the last full run is
 * `FULL_INTERVAL_MS` old), otherwise only repositories whose newest graph changed. A repository
 * gets a `licenses` record when the judgement differs from its newest one, or that record is a day
 * old; older records beyond the analyzer's `keepRecords` are deleted.
 *
 * Packages a repository of the fleet defines are `internal` and never looked up. Repositories
 * whose graph failed to load, has no lockfile the index reads or whose `licenses` is turned off get
 * no record. When deps.dev fails the run throws and writes nothing. Needs `store.kv`; does nothing
 * without it.
 */
export async function runLicenseIndex(
  deps: LicenseIndexDeps,
  options: LicenseIndexOptions = {},
): Promise<LicenseIndexSummary | undefined> {
  const { config, store } = deps
  const { kv } = store
  if (!kv) return undefined
  const log = options.log ?? (() => {})
  const now = deps.now()
  const today = now.toISOString().slice(0, 10)
  const state = await readState(kv)
  const full =
    options.full === true ||
    state.fullAt === undefined ||
    now.getTime() - Date.parse(state.fullAt) >= FULL_INTERVAL_MS
  const heads = await store.analyses.latestHeads({ kind: 'depgraph' })
  const due = full
    ? heads
    : heads.filter((head) => state.repos[repoKey(head.repo)]?.depgraph !== head.id)
  const summary: LicenseIndexSummary = {
    full,
    repos: 0,
    packages: 0,
    fetched: 0,
    written: 0,
    skipped: [],
  }
  if (due.length === 0) return summary

  const catalog = await loadPackageCatalog(store.analyses)
  const internal = (ecosystem: string, name: string) => {
    const found = catalog.find(ecosystem, name)
    return found && repoKey(found.repo)
  }

  const loaded: Loaded[] = []
  for (const head of due)
    // oxlint-disable-next-line no-await-in-loop -- one graph in memory at a time
    loaded.push(await loadRepo(deps, head))

  const lookup = await lookupLicenses({
    client: options.client ?? depsDevClient(),
    cache: options.cache ?? kvLicenseCache(kv),
    now,
    packages: loaded.flatMap((each) =>
      each.inventory && !each.inventory.problem
        ? each.inventory.packages.filter((pkg) => !internal(pkg.ecosystem, pkg.name))
        : [],
    ),
    ...(options.signal && { signal: options.signal }),
  })
  summary.packages = lookup.queried
  summary.fetched = lookup.fetched

  const rootFiles = options.rootFiles ?? forgeRootFiles(deps)
  const live = new Set(heads.map((head) => repoKey(head.repo)))
  const repos: Record<string, RepoState> = Object.fromEntries(
    Object.entries(state.repos).filter(([key]) => live.has(key)),
  )
  for (const each of loaded) {
    const previous = repos[each.key]
    const graphChanged = previous?.depgraph !== each.head.id
    let licenseFiles = graphChanged ? undefined : previous?.licenseFiles
    const keep = (reason: string): void => {
      summary.skipped.push({ repo: each.key, reason })
      repos[each.key] = {
        depgraph: each.head.id,
        ...(licenseFiles && { licenseFiles }),
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
    if (await analyzerOffFor(store, config, each.repo, licensesAnalyzer.kind)) {
      keep('licenses is turned off')
      continue
    }
    // oxlint-disable-next-line no-await-in-loop
    const scoped = await scopedAnalyzerOptions(config, store, {
      analyzer: licensesAnalyzer.kind,
      repo: each.repo,
    })
    const licensesOptions = licensesAnalyzer.options.safeParse(scoped ?? {})
    if (!licensesOptions.success) {
      keep('the licenses settings are not valid')
      continue
    }
    if (!licenseFiles)
      try {
        // oxlint-disable-next-line no-await-in-loop
        licenseFiles = (await rootFiles(each.repo))?.filter(projectLicenseFile).toSorted()
      } catch (error) {
        log(
          `license index: cannot list ${each.key}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }

    summary.repos += 1
    const devOnly = each.devOnly
    const data = inventoryLicenses({
      packages: each.inventory.packages,
      licenses: lookup.licenses,
      policy: licensesOptions.data,
      internal,
      ...(devOnly && {
        devOnly: (ecosystem: string, name: string, version: string) =>
          devOnly.has(devKey(ecosystem, name, version)),
      }),
      ...(licenseFiles && { licenseFiles }),
      today,
    })

    // oxlint-disable-next-line no-await-in-loop
    const [latest] = await store.analyses.latest({ repo: each.repo, kind: licensesAnalysis.kind })
    const latestData: LicensesData | undefined = licensesDataSchema.safeParse(latest?.data).data
    const changed = !latestData || !sameLicensesState(latestData, data)
    const stale = !latest || now.getTime() - Date.parse(latest.createdAt) >= HEARTBEAT_MS
    if (changed || stale) {
      const createdAt = now.toISOString()
      // oxlint-disable-next-line no-await-in-loop
      const metrics = await recordMetrics(
        store.analyses,
        licensesAnalysis,
        { repo: each.repo, createdAt, data },
        licensesOptions.data,
      )
      // oxlint-disable-next-line no-await-in-loop
      await store.analyses.add({
        repo: each.repo,
        kind: licensesAnalysis.kind,
        ...(each.head.sha !== undefined && { sha: each.head.sha }),
        createdAt,
        actor: LICENSE_INDEX_ACTOR,
        data,
        ...(metrics !== undefined && { metrics }),
      })
      if (licensesAnalyzer.keepRecords)
        // oxlint-disable-next-line no-await-in-loop
        await store.analyses.prune({
          repo: each.repo,
          kind: licensesAnalysis.kind,
          keep: licensesAnalyzer.keepRecords,
        })
      summary.written += 1
    }
    repos[each.key] = { depgraph: each.head.id, ...(licenseFiles && { licenseFiles }) }
  }

  await kv.set(STATE_KEY, {
    ...(full ? { fullAt: now.toISOString() } : state.fullAt ? { fullAt: state.fullAt } : {}),
    repos,
  })
  log(
    `license index: ${full ? 'full' : 'changed'} run judged ${summary.repos} repositor${summary.repos === 1 ? 'y' : 'ies'} ` +
      `(${summary.packages} package versions, ${summary.fetched} looked up), ` +
      `${summary.written} record(s) written` +
      (summary.skipped.length ? `, ${summary.skipped.length} skipped` : ''),
  )
  return summary
}

/**
 * The leader duty of the license index: a run every minute that judges repositories with a new
 * dependency graph, and all of them once an hour. After a failed run it waits ten minutes.
 */
export function licenseIndexDuty(
  deps: LicenseIndexDeps,
  options: Omit<LicenseIndexOptions, 'full' | 'signal'> = {},
): LeaderDuty {
  return () => {
    let running: Promise<unknown> | undefined
    let retryAt = 0
    const controller = new AbortController()
    const run = () => {
      if (Date.now() < retryAt) return
      running ??= runLicenseIndex(deps, { ...options, signal: controller.signal })
        .catch((error: unknown) => {
          retryAt = Date.now() + RETRY_MS
          options.log?.(
            `license index: run failed: ${error instanceof Error ? error.message : String(error)}`,
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
