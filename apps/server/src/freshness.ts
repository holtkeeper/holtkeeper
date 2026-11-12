import { budgetGuard } from '@holtkeeper/ai-usage'
import { defaultBranchHead } from '@holtkeeper/analyzer'
import type { BranchPushedEvent, GitForge, RepoRef } from '@holtkeeper/forge'
import {
  type FreshnessDecision,
  type FreshnessMode,
  type NightWindow,
  decideFreshness,
  enqueueUnique,
  matchesAnyPath,
  systemTimeZone,
} from '@holtkeeper/jobs'
import { analyzerOff, defineSetting, repoAnalyzersKey, resolveSetting } from '@holtkeeper/settings'
import type { AnalysisHead, Job, KvStore } from '@holtkeeper/store'
import { z } from 'zod'

import { type JobAnalyzerInfo, type ServerDeps, repoKey } from './context.ts'
import { automaticJobBlocker } from './jobs.ts'
import { forgeLimitKey } from './limits.ts'
import { offText } from './repo-analyzers.ts'
import { jobTarget } from './routes/jobs.ts'
import { listedRepos } from './updates.ts'

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM')

const freshnessSchema = z.object({
  mode: z.enum(['on', 'off', 'slower']).default('on'),
  factor: z.number().min(1).max(20).default(3),
})

/** Setting `freshness` (section `Automation`): a team's override of automatic refreshes. */
export const freshnessSetting = defineSetting({
  key: 'freshness',
  label: 'Freshness',
  description:
    'Whether analyses of these repositories refresh on their own when the default branch moves or their data ages: on (default), off, or slower by a factor.',
  section: 'Automation',
  help: `Every analyzer declares when its data goes stale: after the default branch moved (at most once per its minimum interval), or after a cadence for data that changes without commits (advisories, registries, CI history). A leader process checks every few minutes and queues what is stale.

- **mode** \`on\` (default) refreshes as the analyzers declare, \`off\` never refreshes automatically (events, schedules and runs by hand still work), \`slower\` stretches every interval and cadence by **factor** (default 3).
- Scope it to a group to set it for one team. The most specific entry wins.`,
  default: freshnessSchema.parse({}),
  schema: freshnessSchema,
  presets: [
    { id: 'on', label: 'On', value: { mode: 'on' } },
    { id: 'slower', label: 'Slower', value: { mode: 'slower', factor: 3 } },
    { id: 'off', label: 'Off', value: { mode: 'off' } },
  ],
})

const sweepSchema = z.object({
  maxJobsPerHour: z.number().int().min(0).max(500).default(10),
  maxAiJobsPerHour: z.number().int().min(0).max(100).default(2),
  nightWindow: z.object({ from: hhmm, to: hhmm }).default({ from: '01:00', to: '07:00' }),
  headPollMinutes: z.number().int().min(5).max(1440).default(30),
})

/** A `freshness.sweep` value with defaults applied. */
type FreshnessSweepConfig = z.infer<typeof sweepSchema>

/** Setting `freshness.sweep` (global, section `Automation`): limits of the freshness sweeper. */
export const freshnessSweepSetting = defineSetting({
  key: 'freshness.sweep',
  label: 'Freshness limits',
  description:
    'How many jobs freshness may queue per hour, the night window heavy analyzers wait for, and how often default-branch heads are read.',
  section: 'Automation',
  global: true,
  help: `- **maxJobsPerHour** (default 10): jobs freshness queues in any hour, so the first sweep after an upgrade (every record without a commit counts as stale) and bursts of merges spread out. 0 stops freshness.
- **maxAiJobsPerHour** (default 2): of those, jobs of analyzers that may call an LLM. They also stop once automatic work reached the weekly budget minus its reserve.
- **nightWindow** (default 01:00 to 07:00, instance time zone): heavy analyzers (coverage, bundle size, assets, Renovate) run only then.
- **headPollMinutes** (default 30): how often the default-branch head of each repository is read, one cheap request each; push webhooks report moves at once.`,
  default: sweepSchema.parse({}),
  schema: sweepSchema,
})

/** How often the sweeper looks for stale analyses. */
const SWEEP_MS = 5 * 60_000
/** Delay of the first sweep after a process became leader. */
const FIRST_SWEEP_MS = 60_000
/** Heads read per sweep at most; the rest wait for the next one. */
const HEADS_PER_SWEEP = 25
/** How much longer than `headPollMinutes` a repository whose head could not be read waits. */
const MISS_BACKOFF = 4
const HEAD_TTL_SECONDS = 30 * 86_400

const SUMMARY_KEY = 'freshness:summary'
const SUMMARY_TTL_SECONDS = 86_400

const summarySchema = z.object({
  at: z.string(),
  entries: z.array(
    z.object({
      analyzer: z.string(),
      repo: z.string(),
      group: z.string().optional(),
      action: z.enum(['run', 'wait', 'fresh', 'skip']),
    }),
  ),
})

/** What the last sweep decided per analyzer and target, kept for Ops › Automation. */
type SweepSummary = z.infer<typeof summarySchema>

const headKey = (repo: RepoRef) => `freshness:head:${repoKey(repo)}`
const missKey = (repo: RepoRef) => `freshness:head-miss:${repoKey(repo)}`
const appliesKey = (repo: RepoRef, kind: string) => `freshness:applies:${repoKey(repo)}:${kind}`
const pathsKey = (repo: RepoRef, kind: string) => `freshness:paths:${repoKey(repo)}:${kind}`

/** The default-branch head freshness knows of a repository. */
export interface KnownHead {
  sha: string
  /** When this sha was first seen as the head. */
  at: string
  /** When the head was last read or reported. */
  checkedAt: string
}

const knownHeadSchema = z.object({ sha: z.string(), at: z.string(), checkedAt: z.string() })

/** The default-branch head freshness last saw of `repo`, without asking the forge. */
export async function readHead(kv: KvStore, repo: RepoRef): Promise<KnownHead | undefined> {
  return knownHeadSchema.safeParse(await kv.get(headKey(repo))).data
}

/** Records `sha` as the repository's default-branch head; a new sha restarts the debounce. */
export async function noteHead(kv: KvStore, repo: RepoRef, sha: string, now: Date) {
  const known = await readHead(kv, repo)
  const at = now.toISOString()
  const next: KnownHead =
    known?.sha === sha ? { ...known, checkedAt: at } : { sha, at, checkedAt: at }
  await kv.set(headKey(repo), next, HEAD_TTL_SECONDS)
}

/**
 * Records the head a push to the repository's default branch reported (from the event, else the
 * forge's `getRepository`), so the sweeper sees the move without polling. Pushes to other branches
 * and failures are ignored.
 */
export async function noteDefaultBranchPush(
  deps: Pick<ServerDeps, 'store' | 'config' | 'now'>,
  event: BranchPushedEvent,
): Promise<void> {
  const kv = deps.store.kv
  if (!kv) return
  let branch = event.defaultBranch
  if (!branch)
    try {
      branch = (await deps.config.forges[event.repo.forge]?.create().getRepository(event.repo.path))
        ?.defaultBranch
    } catch {
      return
    }
  if (branch !== event.branch) return
  await noteHead(kv, event.repo, event.sha, deps.now())
}

/** Freshness settings resolved for one sweep. */
async function sweepConfig(deps: Pick<ServerDeps, 'store'>): Promise<FreshnessSweepConfig> {
  const entry = (await deps.store.settings.list(freshnessSweepSetting.key)).find(
    (candidate) => candidate.scope.all === true && !candidate.secret,
  )
  return sweepSchema.safeParse(entry?.value ?? {}).data ?? sweepSchema.parse({})
}

/** One analyzer on one repository (or group), as freshness sees it now. */
interface FreshnessEntry {
  analyzer: string
  repo: RepoRef
  group?: string
  refresh: NonNullable<JobAnalyzerInfo['refresh']>
  latest?: Pick<AnalysisHead, 'id' | 'sha' | 'createdAt'>
  head?: KnownHead
  decision: FreshnessDecision
  /** Due, but whether the analyzer applies is not cached yet; the sweep asks the forge lazily. */
  unchecked?: true
}

type FreshnessDeps = Pick<
  ServerDeps,
  'config' | 'store' | 'analyzers' | 'now' | 'limiter' | 'configSource'
>

interface Target {
  repo: RepoRef
  group?: string
}

/**
 * Evaluates freshness over `targets` (every listed repository and every group when absent): one
 * entry per target and analyzer that declares `refresh`, with the decision of `decideFreshness`
 * refined by checks that cost reads: whether the analyzer applies to the repository (cached per
 * head) and whether its options are set up there (for due entries, and waiting ones of explicit
 * `targets`), whether matching files changed (`refresh.paths`)
 * and, for analyzers that may call an LLM, whether the weekly budget for automatic work allows it.
 */
async function evaluate(
  deps: FreshnessDeps,
  options: {
    targets?: Target[]
    sweep: FreshnessSweepConfig
    budget: ReturnType<typeof budgetGuard>
    timezone?: string
    /** Leave uncached `appliesTo` reads to the caller (`unchecked` entries). */
    deferApplies?: boolean
  },
): Promise<FreshnessEntry[]> {
  const { config, store } = deps
  const kv = store.kv
  if (!kv) return []
  const now = deps.now()
  const analyzers = (deps.analyzers ?? []).filter((analyzer) => analyzer.refresh !== undefined)
  if (!analyzers.length) return []
  const targets: Target[] =
    options.targets ??
    [
      ...(await listedRepos(kv, config)).map((repo) => ({ repo })),
      ...Object.keys(config.groups).map((group) => ({
        repo: { forge: config.groups[group]?.forge ?? '', path: group },
        group,
      })),
    ].filter((target) => target.repo.forge in config.forges)

  const latest = new Map<string, AnalysisHead>()
  for (const head of await store.analyses.latestHeads())
    latest.set(`${repoKey(head.repo)}\0${head.kind}`, head)
  const active = new Set(
    (await store.jobs.list({ status: ['queued', 'running'], limit: 2000 })).map(
      (job) => `${repoKey(job.repo)}\0${job.analyzer}`,
    ),
  )
  const lastJobs = new Map<string, Job>()
  for (const job of await store.jobs.list({ trigger: 'freshness', limit: 1000 })) {
    const key = `${repoKey(job.repo)}\0${job.analyzer}`
    if (!lastJobs.has(key)) lastJobs.set(key, job)
  }
  const [settings, switches] = await Promise.all([
    store.settings.list(freshnessSetting.key),
    store.settings.list(repoAnalyzersKey),
  ])
  const forges = new Map<string, GitForge | undefined>()
  const forgeOf = (id: string) => {
    if (!forges.has(id)) forges.set(id, config.forges[id]?.create())
    return forges.get(id)
  }
  const context = {
    now,
    nightWindow: options.sweep.nightWindow satisfies NightWindow,
    timezone: options.timezone ?? systemTimeZone(),
  }

  const entries: FreshnessEntry[] = []
  for (const target of targets) {
    const scope = jobTarget(config, target)
    const entry = resolveSetting(settings, freshnessSetting.key, scope)
    const mode: FreshnessMode =
      freshnessSchema.safeParse(entry && !entry.secret ? entry.value : {}).data ??
      freshnessSchema.parse({})
    // oxlint-disable-next-line no-await-in-loop -- one store read per repository
    const head = target.group === undefined ? await readHead(kv, target.repo) : undefined
    for (const analyzer of analyzers) {
      const refresh = analyzer.refresh
      if (!refresh) continue
      if ((analyzer.scope === 'group') !== (target.group !== undefined)) continue
      const kind = analyzer.analysis?.kind ?? analyzer.kind
      const key = `${repoKey(target.repo)}\0${analyzer.kind}`
      const record = latest.get(`${repoKey(target.repo)}\0${kind}`)
      const ai = analyzer.needs?.agent !== undefined
      const lastJob = lastJobs.get(key)
      const base = {
        refresh,
        ai,
        ...(record && {
          latest: { createdAt: record.createdAt, ...(record.sha && { sha: record.sha }) },
        }),
        ...(head && { head: { sha: head.sha, at: head.at } }),
        active: active.has(key),
        ...(lastJob && { lastJob }),
        mode,
      }
      const off =
        target.group === undefined ? analyzerOff(switches, scope, analyzer.kind) : undefined
      let decision: FreshnessDecision = off
        ? { action: 'skip', reason: offText(off) }
        : decideFreshness(base, context)
      const forge = forgeOf(target.repo.forge)
      if (
        decision.action !== 'skip' &&
        decision.action !== 'fresh' &&
        refresh.on === 'change' &&
        refresh.paths?.length &&
        record?.sha &&
        head &&
        forge
      ) {
        // oxlint-disable-next-line no-await-in-loop -- memoized per head, rarely more than a few
        const changed = await pathsChanged(kv, forge, target.repo, analyzer.kind, {
          from: record.sha,
          to: head.sha,
          paths: refresh.paths,
        })
        if (changed === false) decision = decideFreshness({ ...base, pathsChanged: false }, context)
      }
      let unchecked = false
      if (decision.action === 'run' || (options.targets && decision.action === 'wait')) {
        // oxlint-disable-next-line no-await-in-loop -- cached per head, so mostly store reads
        const skip = await notApplicable(deps, kv, forge, target, analyzer, head?.sha, {
          cachedOnly: options.deferApplies === true,
        })
        if (skip === UNCHECKED) unchecked = true
        else if (skip) decision = { action: 'skip', reason: skip }
      }
      if (decision.action === 'run' && ai) {
        // oxlint-disable-next-line no-await-in-loop -- few analyzers may call an LLM
        const verdict = await options.budget.check({
          repo: scope,
          taskKind: analyzer.kind,
          interactive: false,
        })
        if (!verdict.allowed)
          decision = {
            action: 'wait',
            reason: 'automatic AI work reached the weekly budget minus its reserve',
          }
      }
      entries.push({
        analyzer: analyzer.kind,
        repo: target.repo,
        ...(target.group !== undefined && { group: target.group }),
        refresh,
        ...(record && { latest: record }),
        ...(head && { head }),
        decision,
        ...(unchecked && decision.action === 'run' && { unchecked: true as const }),
      })
    }
  }
  return entries
}

const UNCHECKED = Symbol('unchecked')

/**
 * Why freshness leaves the analyzer out on the target, or `undefined` when it may run there.
 * With `cachedOnly`, `UNCHECKED` instead of an `appliesTo` read the cache cannot answer.
 */
async function notApplicable(
  deps: FreshnessDeps,
  kv: KvStore,
  forge: GitForge | undefined,
  target: Target,
  analyzer: JobAnalyzerInfo,
  head: string | undefined,
  options: { cachedOnly?: boolean } = {},
): Promise<string | undefined | typeof UNCHECKED> {
  const request = { analyzer: analyzer.kind, ...target }
  const blocked = await automaticJobBlocker(deps.config, deps.store, analyzer, request)
  if (blocked?.blocker === 'off') return offText(blocked)
  if (blocked?.blocker === 'no-tests') return 'the repository has no tests by design'
  if (blocked?.blocker === 'frozen')
    return 'the repository is read-only for Holtkeeper (repo.freeze) and the analyzer would change it'
  if (blocked?.blocker === 'options')
    return `its options are not set up for this ${target.group === undefined ? 'repository' : 'group'}`
  if (!analyzer.appliesTo || target.group !== undefined || !forge) return undefined
  const cached = z
    .object({ sha: z.string().optional(), applies: z.boolean() })
    .safeParse(await kv.get(appliesKey(target.repo, analyzer.kind))).data
  let applies = cached && cached.sha === head ? cached.applies : undefined
  if (applies === undefined && options.cachedOnly) return UNCHECKED
  if (applies === undefined) {
    try {
      applies = await analyzer.appliesTo({ repo: target.repo, forge })
    } catch {
      applies = true
    }
    await kv.set(
      appliesKey(target.repo, analyzer.kind),
      { ...(head && { sha: head }), applies },
      HEAD_TTL_SECONDS,
    )
  }
  return applies ? undefined : 'the repository does not use what it analyzes'
}

/**
 * Whether a file matching `paths` changed between two commits, from the forge's comparison,
 * memoized per pair; `undefined` when the forge cannot tell.
 */
async function pathsChanged(
  kv: KvStore,
  forge: GitForge,
  repo: RepoRef,
  kind: string,
  range: { from: string; to: string; paths: readonly string[] },
): Promise<boolean | undefined> {
  const memo = z
    .object({ from: z.string(), to: z.string(), changed: z.boolean() })
    .safeParse(await kv.get(pathsKey(repo, kind))).data
  if (memo && memo.from === range.from && memo.to === range.to) return memo.changed
  if (!forge.compareCommits) return undefined
  try {
    const files = await forge.compareCommits(repo.path, range.from, range.to)
    const changed = matchesAnyPath(
      files.flatMap((file) => [file.newPath, file.oldPath]),
      range.paths,
    )
    await kv.set(
      pathsKey(repo, kind),
      { from: range.from, to: range.to, changed },
      HEAD_TTL_SECONDS,
    )
    return changed
  } catch {
    return undefined
  }
}

async function readMiss(kv: KvStore, repo: RepoRef): Promise<number | undefined> {
  const at = z.object({ at: z.string() }).safeParse(await kv.get(missKey(repo))).data?.at
  return at === undefined ? undefined : Date.parse(at)
}

/**
 * Reads the default-branch head of repositories whose head is older than `headPollMinutes`, the
 * longest unchecked first, at most `HEADS_PER_SWEEP`, skipping forges whose credential is
 * saturated. A repository whose head could not be read (empty, inaccessible) waits
 * `MISS_BACKOFF` times as long before the next try. Returns how many it read.
 */
async function pollHeads(
  deps: FreshnessDeps,
  kv: KvStore,
  sweep: FreshnessSweepConfig,
): Promise<number> {
  const now = deps.now()
  const due: { repo: RepoRef; checkedAt: number }[] = []
  for (const repo of await listedRepos(kv, deps.config)) {
    if (!(repo.forge in deps.config.forges)) continue
    // oxlint-disable-next-line no-await-in-loop -- two store reads per repository
    const [known, miss] = await Promise.all([readHead(kv, repo), readMiss(kv, repo)])
    const read = known ? Date.parse(known.checkedAt) : 0
    const missed = miss ?? 0
    const checkedAt = Math.max(read, missed)
    const wait = sweep.headPollMinutes * 60_000 * (missed > read ? MISS_BACKOFF : 1)
    if (now.getTime() - checkedAt >= wait) due.push({ repo, checkedAt })
  }
  const forges = new Map<string, GitForge | undefined>()
  let read = 0
  for (const { repo } of due.toSorted((a, b) => a.checkedAt - b.checkedAt)) {
    if (read >= HEADS_PER_SWEEP) break
    const key =
      deps.configSource?.effective().forges[repo.forge]?.credentialId ?? forgeLimitKey(repo.forge)
    // oxlint-disable-next-line no-await-in-loop -- one request at a time keeps forge limits
    if (deps.limiter && (await deps.limiter.saturated(key))) continue
    if (!forges.has(repo.forge)) forges.set(repo.forge, deps.config.forges[repo.forge]?.create())
    const forge = forges.get(repo.forge)
    if (!forge) continue
    // oxlint-disable-next-line no-await-in-loop -- see above
    const sha = await defaultBranchHead(forge, repo.path)
    read++
    // oxlint-disable-next-line no-await-in-loop -- see above
    if (sha) await noteHead(kv, repo, sha, deps.now())
    // oxlint-disable-next-line no-await-in-loop -- see above
    else await kv.set(missKey(repo), { at: deps.now().toISOString() }, HEAD_TTL_SECONDS)
  }
  return read
}

/** What one sweep did. */
export interface SweepResult {
  heads: number
  queued: Job[]
  /** Stale entries left for a later sweep by the hourly caps. */
  capped: number
}

const HOUR_MS = 3_600_000

/**
 * One freshness sweep (nothing without a key-value store or a `jobs` config): reads due default-branch heads, evaluates every target, and queues the
 * entries that should run (trigger `freshness`, the decision's reason on the job) up to what is
 * left of `maxJobsPerHour` and, for analyzers that may call an LLM, `maxAiJobsPerHour`, counting
 * freshness jobs created in the last hour. The longest-stale entries go first (no record, then
 * the oldest record); the rest wait for a later sweep.
 */
export async function sweepFreshness(
  deps: FreshnessDeps,
  options: {
    budget?: ReturnType<typeof budgetGuard>
    /** Zone of the night window; default the instance's. */
    timezone?: string
    log?: (line: string) => void
  } = {},
): Promise<SweepResult> {
  const kv = deps.store.kv
  if (!kv) return { heads: 0, queued: [], capped: 0 }
  const sweep = await sweepConfig(deps)
  const heads = await pollHeads(deps, kv, sweep)
  const budget = options.budget ?? guardFor(deps)
  const entries = await evaluate(deps, {
    sweep,
    budget,
    deferApplies: true,
    ...(options.timezone && { timezone: options.timezone }),
  })
  const now = deps.now()
  const recent = (await deps.store.jobs.list({ trigger: 'freshness', limit: 1000 })).filter(
    (job) => now.getTime() - Date.parse(job.createdAt) < HOUR_MS,
  )
  const aiKinds = new Set(
    (deps.analyzers ?? [])
      .filter((analyzer) => analyzer.needs?.agent !== undefined)
      .map((analyzer) => analyzer.kind),
  )
  let left = Math.max(sweep.maxJobsPerHour - recent.length, 0)
  let aiLeft = Math.max(
    sweep.maxAiJobsPerHour - recent.filter((job) => aiKinds.has(job.analyzer)).length,
    0,
  )
  const due = entries
    .filter((entry) => entry.decision.action === 'run')
    .toSorted((a, b) => (a.latest?.createdAt ?? '').localeCompare(b.latest?.createdAt ?? ''))
  const picked: FreshnessEntry[] = []
  const analyzerOf = new Map((deps.analyzers ?? []).map((analyzer) => [analyzer.kind, analyzer]))
  const forges = new Map<string, GitForge | undefined>()
  const saturated = new Set<string>()
  let skipped = 0
  for (const entry of due) {
    if (left === 0) break
    const ai = aiKinds.has(entry.analyzer)
    if (ai && aiLeft === 0) continue
    if (entry.unchecked) {
      if (saturated.has(entry.repo.forge)) continue
      const limitKey =
        deps.configSource?.effective().forges[entry.repo.forge]?.credentialId ??
        forgeLimitKey(entry.repo.forge)
      // oxlint-disable-next-line no-await-in-loop -- reads stop once the caps are full
      if (deps.limiter && (await deps.limiter.saturated(limitKey))) {
        saturated.add(entry.repo.forge)
        continue
      }
      if (!forges.has(entry.repo.forge))
        forges.set(entry.repo.forge, deps.config.forges[entry.repo.forge]?.create())
      const analyzer = analyzerOf.get(entry.analyzer)
      const skip =
        analyzer &&
        // oxlint-disable-next-line no-await-in-loop -- see above
        (await notApplicable(
          deps,
          kv,
          forges.get(entry.repo.forge),
          { repo: entry.repo, ...(entry.group !== undefined && { group: entry.group }) },
          analyzer,
          entry.head?.sha,
        ))
      delete entry.unchecked
      if (typeof skip === 'string') {
        entry.decision = { action: 'skip', reason: skip }
        skipped++
        continue
      }
    }
    if (ai) aiLeft--
    left--
    picked.push(entry)
  }
  await kv.set(
    SUMMARY_KEY,
    {
      at: now.toISOString(),
      entries: entries.map((entry) => ({
        analyzer: entry.analyzer,
        repo: repoKey(entry.repo),
        ...(entry.group !== undefined && { group: entry.group }),
        action: entry.decision.action,
      })),
    } satisfies SweepSummary,
    SUMMARY_TTL_SECONDS,
  )
  const { enqueued } = await enqueueUnique(
    deps.store.jobs,
    picked.map((entry) => ({
      analyzer: entry.analyzer,
      repo: entry.repo,
      ...(entry.group !== undefined && { group: entry.group }),
      trigger: 'freshness' as const,
      ...(entry.decision.action === 'run' && { reason: entry.decision.reason }),
    })),
    now.toISOString(),
  )
  const capped = due.length - picked.length - skipped
  if (enqueued.length || capped)
    options.log?.(
      `freshness: ${enqueued.length} job(s) queued${capped ? `, ${capped} stale left for later by the hourly cap` : ''}`,
    )
  return { heads, queued: enqueued, capped }
}

const guardFor = (deps: Pick<ServerDeps, 'store' | 'now'>) =>
  budgetGuard({ settings: deps.store.settings, usage: deps.store.aiUsage, now: deps.now })

/** Freshness of one analyzer on one target, for people and agents. */
export interface FreshnessStatus extends FreshnessEntry {
  /** The sweeper would queue it on its next pass: due, and the hourly caps have room. */
  wouldRun: boolean
}

/**
 * Freshness of every analyzer that declares `refresh` on `target` (a repository, or a group with
 * `group` set), without queuing anything or reading heads from the forge: the head is the one
 * freshness last saw. `wouldRun` also accounts for the hourly caps.
 */
export async function freshnessStatus(
  deps: FreshnessDeps,
  target: Target,
  options: { timezone?: string } = {},
): Promise<FreshnessStatus[]> {
  const sweep = await sweepConfig(deps)
  const entries = await evaluate(deps, {
    targets: [target],
    sweep,
    budget: guardFor(deps),
    ...(options.timezone && { timezone: options.timezone }),
  })
  const now = deps.now().getTime()
  const recent = (await deps.store.jobs.list({ trigger: 'freshness', limit: 1000 })).filter(
    (job) => now - Date.parse(job.createdAt) < HOUR_MS,
  )
  const aiKinds = new Set(
    (deps.analyzers ?? [])
      .filter((analyzer) => analyzer.needs?.agent !== undefined)
      .map((analyzer) => analyzer.kind),
  )
  const room = recent.length < sweep.maxJobsPerHour
  const aiRoom = recent.filter((job) => aiKinds.has(job.analyzer)).length < sweep.maxAiJobsPerHour
  return entries.map((entry) => ({
    ...entry,
    wouldRun: entry.decision.action === 'run' && room && (aiRoom || !aiKinds.has(entry.analyzer)),
  }))
}

/** Counts of one analyzer's targets by what the last sweep decided. */
interface FreshnessCounts {
  analyzer: string
  /** Due: the sweeper queues them as the hourly caps allow. */
  stale: number
  /** Stale or due, but held back: debounce, night window, budget, a running job. */
  waiting: number
  fresh: number
  /** Not run by freshness there: team off, not set up, not applying. */
  skipped: number
}

/** The last sweep's decisions summed per team (config group; `group` absent for every repository). */
export interface FreshnessTeamSummary {
  group?: string
  analyzers: FreshnessCounts[]
}

/**
 * The last sweep's decisions summed per team, over the targets `visible` lets through: every
 * repository counts in the every-repository row and in the row of each of its config groups,
 * group targets in their group's row. `at` is absent before the first sweep (or a day after the
 * last); the next sweep is due `SWEEP_MS` after it.
 */
export async function freshnessSummary(
  deps: Pick<ServerDeps, 'store' | 'config'>,
  visible: (target: { repo: RepoRef; group?: string }) => boolean,
): Promise<{ at?: string; nextAt?: string; sweepMinutes: number; teams: FreshnessTeamSummary[] }> {
  const sweepMinutes = SWEEP_MS / 60_000
  const summary = deps.store.kv
    ? summarySchema.safeParse(await deps.store.kv.get(SUMMARY_KEY)).data
    : undefined
  if (!summary) return { sweepMinutes, teams: [] }
  const teams = new Map<string, Map<string, FreshnessCounts>>()
  const add = (
    team: string,
    analyzer: string,
    action: SweepSummary['entries'][number]['action'],
  ) => {
    const counts = teams.get(team) ?? new Map<string, FreshnessCounts>()
    teams.set(team, counts)
    const row = counts.get(analyzer) ?? { analyzer, stale: 0, waiting: 0, fresh: 0, skipped: 0 }
    counts.set(analyzer, row)
    if (action === 'run') row.stale++
    else if (action === 'wait') row.waiting++
    else if (action === 'fresh') row.fresh++
    else row.skipped++
  }
  for (const entry of summary.entries) {
    const separator = entry.repo.indexOf(':')
    const repo = { forge: entry.repo.slice(0, separator), path: entry.repo.slice(separator + 1) }
    const target = { repo, ...(entry.group !== undefined && { group: entry.group }) }
    if (!visible(target)) continue
    const groups = entry.group !== undefined ? [entry.group] : jobTarget(deps.config, target).groups
    add('', entry.analyzer, entry.action)
    for (const group of new Set(groups)) add(group, entry.analyzer, entry.action)
  }
  return {
    at: summary.at,
    nextAt: new Date(Date.parse(summary.at) + SWEEP_MS).toISOString(),
    sweepMinutes,
    teams: [...teams.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([group, counts]) => ({
        ...(group !== '' && { group }),
        analyzers: [...counts.values()].toSorted((a, b) => a.analyzer.localeCompare(b.analyzer)),
      })),
  }
}

/**
 * The freshness sweeper as a leader duty: a sweep a minute after taking the lead, then every five
 * minutes; a failing sweep is logged and the next one runs as usual. `undefined` without a
 * key-value store.
 */
export function startFreshness(
  deps: FreshnessDeps,
  log: (line: string) => void = () => {},
): (() => Promise<void>) | undefined {
  if (!deps.store.kv) return undefined
  const budget = guardFor(deps)
  let running: Promise<unknown> | undefined
  const run = () => {
    running ??= sweepFreshness(deps, { budget, log })
      .catch((error: unknown) =>
        log(`freshness: ${error instanceof Error ? error.message : String(error)}`),
      )
      .finally(() => {
        running = undefined
      })
  }
  const first = setTimeout(run, FIRST_SWEEP_MS)
  const timer = setInterval(run, SWEEP_MS)
  return async () => {
    clearTimeout(first)
    clearInterval(timer)
    await running
  }
}
