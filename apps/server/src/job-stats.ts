import type { AnalyzerHealthList, AnalyzerHealthView, JobStats, JobWaitKind } from '@holtkeeper/api'
import type { RepoRef } from '@holtkeeper/forge'
import { type JobWait, claimRulesOf, liveWorkers, waitReasons } from '@holtkeeper/jobs'
import type { Job } from '@holtkeeper/store'

import type { ServerDeps } from './context.ts'

/** Queued and running jobs read to explain waits; claim order spans every repository. */
const QUEUE_SCAN = 1000
/** Started jobs read for claim latency. */
const LATENCY_SCAN = 500
/** Queued jobs whose wait reasons are bucketed. */
const WAIT_SAMPLE = 50
const WINDOW_HOURS = 24
const HOUR_MS = 3_600_000

type StatsDeps = Pick<ServerDeps, 'store' | 'analyzers' | 'now'>

const keyOf = (repo: RepoRef) => `${repo.forge}:${repo.path}`

const claimOrder = (a: Job, b: Job) =>
  a.runAfter.localeCompare(b.runAfter) || a.createdAt.localeCompare(b.createdAt)

/** The value at quantile `q` (0..1) of non-empty ascending `sorted`, nearest rank. */
const percentile = (sorted: readonly number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!

const p50p95 = (sorted: readonly number[]) =>
  sorted.length ? { p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95) } : {}

/** Whether a job belongs to `repos`; `undefined` means every repository. */
const within = (repos: readonly RepoRef[] | undefined) => {
  if (!repos) return () => true
  const keys = new Set(repos.map(keyOf))
  return (job: Pick<Job, 'repo'>) => keys.has(keyOf(job.repo))
}

/** The queued and running jobs, in claim order, that `waitReasons` reads. */
const scanQueue = (deps: StatsDeps) =>
  deps.store.jobs.list({ status: ['queued', 'running'], limit: QUEUE_SCAN })

/**
 * Why each queued job of `jobs` waits (job id → `JobWait`), from the claim rules of the server's
 * analyzers over the whole queue; jobs that are not queued get no entry.
 */
export async function waitHints(deps: StatsDeps, jobs: readonly Job[]) {
  const queued = jobs.filter((job) => job.status === 'queued')
  if (!queued.length) return {}
  const queue = await scanQueue(deps)
  const rules = claimRulesOf(deps.analyzers ?? [])
  const now = deps.now().toISOString()
  return Object.fromEntries(
    queued.map((job): [string, JobWait] => [job.id, waitReasons(job, queue, rules, now)]),
  )
}

/** Which jobs' agent cost the caller may read; `undefined`: none. */
export type CostReader = ((job: Pick<Job, 'repo' | 'group'>) => boolean) | undefined

const finished = new Set<Job['status']>(['succeeded', 'failed', 'blocked', 'canceled'])
const FINISHED_COSTS = 5000
const finishedCosts = new WeakMap<object, Map<string, number>>()

/**
 * What each job's agent runs cost so far (job id → USD), only for jobs `readsCost` allows; jobs
 * without a cost get no entry. Costs of finished jobs are remembered per store.
 */
export async function jobCosts(
  deps: Pick<ServerDeps, 'store' | 'analyzers'>,
  jobs: readonly Job[],
  readsCost: CostReader,
): Promise<Record<string, number>> {
  if (!readsCost) return {}
  const agentKinds = new Set(
    (deps.analyzers ?? []).filter((each) => each.needs?.agent).map((each) => each.kind),
  )
  const cache = finishedCosts.get(deps.store.aiUsage) ?? new Map<string, number>()
  finishedCosts.set(deps.store.aiUsage, cache)
  const costed = jobs.filter((job) => agentKinds.has(job.analyzer) && readsCost(job))
  const sums = await Promise.all(
    costed.map(async (job) => {
      const known = cache.get(job.id)
      if (known !== undefined) return [job.id, known] as const
      const [bucket] = await deps.store.aiUsage.aggregate({ filter: { jobId: job.id } })
      const cost = bucket?.costUsd ?? 0
      if (finished.has(job.status)) {
        if (cache.size >= FINISHED_COSTS) cache.delete(cache.keys().next().value!)
        cache.set(job.id, cost)
      }
      return [job.id, cost] as const
    }),
  )
  return Object.fromEntries(sums.filter(([, cost]) => cost > 0))
}

/**
 * Queue statistics over the jobs of `repos` (`undefined`: every repository), as `JobStats`
 * describes them; `workers` only with `includeWorkers`, read from the worker registry in KV;
 * `running.costUsd` only with `readsCost`, over the running jobs it allows.
 */
export async function jobStats(
  deps: StatsDeps,
  repos: readonly RepoRef[] | undefined,
  includeWorkers: boolean,
  readsCost: CostReader,
): Promise<JobStats> {
  const now = deps.now()
  const since = new Date(now.getTime() - WINDOW_HOURS * HOUR_MS).toISOString()
  const narrow = repos ? { repos: [...repos] } : {}
  const visible = within(repos)
  const [live, recent, queue, started] = await Promise.all([
    deps.store.jobs.count({ ...narrow, status: ['queued', 'running'] }),
    deps.store.jobs.count({ ...narrow, status: ['failed', 'blocked'], since }),
    scanQueue(deps),
    deps.store.jobs.list({
      ...narrow,
      status: ['running', 'succeeded', 'failed', 'blocked', 'canceled'],
      limit: LATENCY_SCAN,
    }),
  ])

  const latencies = started
    .flatMap((job) =>
      job.startedAt && job.startedAt >= since
        ? [Math.max(0, Date.parse(job.startedAt) - Date.parse(job.runAfter))]
        : [],
    )
    .toSorted((a, b) => a - b)

  const rules = claimRulesOf(deps.analyzers ?? [])
  const at = now.toISOString()
  const sample = queue
    .filter((job) => job.status === 'queued' && visible(job))
    .toSorted(claimOrder)
    .slice(0, WAIT_SAMPLE)
  const histogram = new Map<JobWaitKind, number>()
  for (const job of sample) {
    const { reasons } = waitReasons(job, queue, rules, at)
    const kinds = new Set<JobWaitKind>(
      reasons.length ? reasons.map((reason) => reason.kind) : ['capacity'],
    )
    for (const kind of kinds) histogram.set(kind, (histogram.get(kind) ?? 0) + 1)
  }

  const running = queue.filter((job) => job.status === 'running')
  const ownRunning = running.filter(visible)
  const costs = await jobCosts(deps, ownRunning, readsCost)

  const workers =
    includeWorkers && deps.store.kv
      ? (await liveWorkers(deps.store.kv, now)).map(({ id, lastSeen }) => ({
          id,
          lastSeen,
          running: running.filter((job) => job.workerId === id).length,
        }))
      : undefined

  return {
    at,
    windowHours: WINDOW_HOURS,
    queue: {
      queued: live.byStatus.queued,
      running: live.byStatus.running,
      failed: recent.byStatus.failed,
      blocked: recent.byStatus.blocked,
    },
    claimLatency: { samples: latencies.length, ...p50p95(latencies) },
    waits: {
      sampled: sample.length,
      reasons: [...histogram]
        .map(([kind, count]) => ({ kind, count }))
        .toSorted((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
    },
    running: {
      jobs: ownRunning.length,
      ...(readsCost && {
        costUsd:
          Math.round(Object.values(costs).reduce((sum, cost) => sum + cost, 0) * 10_000) / 10_000,
      }),
    },
    ...(workers && { workers }),
  }
}

const ranAt = (job: Job) => job.finishedAt ?? job.startedAt ?? job.createdAt

const latest = (list: readonly Job[]) => list.map(ranAt).toSorted((a, b) => b.localeCompare(a))[0]

/** Jobs read per analyzer for targets, last runs and durations. */
const HEALTH_SCAN = 500
const DAY_MS = 86_400_000

/**
 * Jobs of each analyzer in `kinds` created over the last `days` days, among the jobs of `repos`
 * (`undefined`: every repository), as `AnalyzerHealthView` describes them. `runs`, `failed` and
 * `blocked` count every matching job; targets, last runs and the median duration come from the
 * newest `HEALTH_SCAN` jobs of each analyzer. Analyzers without jobs come back with zeros.
 */
export async function analyzerHealth(
  deps: Pick<ServerDeps, 'store' | 'now'>,
  kinds: readonly string[],
  repos: readonly RepoRef[] | undefined,
  days: number,
): Promise<AnalyzerHealthList> {
  const since = new Date(deps.now().getTime() - days * DAY_MS).toISOString()
  const narrow = repos ? { repos: [...repos] } : {}
  const analyzers = await Promise.all(
    kinds.map(async (analyzer): Promise<AnalyzerHealthView> => {
      const [counts, recent] = await Promise.all([
        deps.store.jobs.count({ ...narrow, analyzer, since }),
        deps.store.jobs.list({
          ...narrow,
          analyzer,
          status: ['running', 'succeeded', 'failed', 'blocked', 'canceled'],
          limit: HEALTH_SCAN,
        }),
      ])
      const jobs = recent.filter((job) => job.createdAt >= since)
      const durations = jobs
        .flatMap((job) =>
          job.startedAt && job.finishedAt && job.status !== 'canceled'
            ? [Math.max(0, Date.parse(job.finishedAt) - Date.parse(job.startedAt))]
            : [],
        )
        .toSorted((a, b) => a - b)
      const lastRunAt = latest(jobs)
      const lastFailureAt = latest(jobs.filter((job) => job.status === 'failed'))
      return {
        analyzer,
        runs: counts.total - counts.byStatus.queued,
        failed: counts.byStatus.failed,
        blocked: counts.byStatus.blocked,
        targets: new Set(jobs.map((job) => keyOf(job.repo))).size,
        ...(lastRunAt && { lastRunAt }),
        ...(lastFailureAt && { lastFailureAt }),
        ...(durations.length && { medianDurationMs: percentile(durations, 0.5) }),
      }
    }),
  )
  return { days, analyzers }
}
