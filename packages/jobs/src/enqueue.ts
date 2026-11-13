import type { RepoRef } from '@holtkeeper/forge'
import type { Job, JobStore, JobTrigger, Timestamp } from '@holtkeeper/store'

/** A job to create; `enqueueUnique` fills in the timestamps. */
export interface JobRequest {
  analyzer: string
  repo: RepoRef
  group?: string
  ref?: string
  options?: Record<string, unknown>
  trigger: JobTrigger
  actor?: string
  /** Schedule that asked for the job. */
  schedule?: string
  /** Why the automation asked for it; see `Job.reason`. */
  reason?: string
  /** Not claimed before this time; default: at once. */
  runAfter?: Timestamp
}

const sameRef = (a: string | undefined, b: string | undefined) => (a ?? '') === (b ?? '')

/** Most jobs per UTC day by analyzer kind, from the analyzers that declare `dailyLimit`. */
export function dailyLimitsOf(
  analyzers: readonly { kind: string; dailyLimit?: number }[],
): Record<string, number> {
  return Object.fromEntries(
    analyzers.flatMap((analyzer) =>
      analyzer.dailyLimit !== undefined && analyzer.dailyLimit > 0
        ? [[analyzer.kind, analyzer.dailyLimit]]
        : [],
    ),
  )
}

/** What `enqueueUnique` also honors. */
export interface EnqueueOptions {
  /** Most jobs per UTC day by analyzer kind (`dailyLimitsOf`). */
  dailyLimits?: Readonly<Record<string, number>>
}

const DAY_MS = 86_400_000

/** Jobs of one analyzer the day limit counts: every job but canceled ones. */
const LOAD_JOBS = 1_000

const dayOf = (at: Timestamp) => Math.floor(Date.parse(at) / DAY_MS)

/**
 * Enqueues each request unless a queued or running job already covers the same analyzer,
 * repository and ref. With `dailyLimits`, a request of a limited kind whose day (its `runAfter`,
 * or `at`) already holds that many jobs of the kind, counted by `runAfter` and without canceled
 * ones, gets `runAfter` at the start of the next UTC day with room.
 */
export async function enqueueUnique(
  store: JobStore,
  requests: JobRequest[],
  at: Timestamp,
  options: EnqueueOptions = {},
): Promise<{ enqueued: Job[]; skipped: JobRequest[] }> {
  const enqueued: Job[] = []
  const skipped: JobRequest[] = []
  const loads = new Map<string, Map<number, number>>()
  const loadOf = async (analyzer: string) => {
    const known = loads.get(analyzer)
    if (known) return known
    const load = new Map<number, number>()
    for (const job of await store.list({ analyzer, limit: LOAD_JOBS }))
      if (job.status !== 'canceled') {
        const day = dayOf(job.runAfter)
        load.set(day, (load.get(day) ?? 0) + 1)
      }
    loads.set(analyzer, load)
    return load
  }
  for (const request of requests) {
    // oxlint-disable-next-line no-await-in-loop -- requests are checked and queued in order
    const active = await store.list({
      status: ['queued', 'running'],
      repo: request.repo,
      analyzer: request.analyzer,
      limit: 500,
    })
    if (active.some((job) => sameRef(job.ref, request.ref))) {
      skipped.push(request)
      continue
    }
    let queued = request
    const limit = options.dailyLimits?.[request.analyzer]
    if (limit !== undefined && limit > 0) {
      // oxlint-disable-next-line no-await-in-loop -- read once per analyzer, then cached
      const load = await loadOf(request.analyzer)
      const wanted = dayOf(request.runAfter ?? at)
      let day = wanted
      while ((load.get(day) ?? 0) >= limit) day += 1
      load.set(day, (load.get(day) ?? 0) + 1)
      if (day !== wanted) queued = { ...request, runAfter: new Date(day * DAY_MS).toISOString() }
    }
    // oxlint-disable-next-line no-await-in-loop -- see above
    enqueued.push(await store.enqueue({ ...queued, createdAt: at }))
  }
  return { enqueued, skipped }
}
