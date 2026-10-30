import type { RepoRef } from '@holtkeeper/forge'
import type { Job, Timestamp } from '@holtkeeper/store'

/** The jobs one schedule run queued together, summed by status. */
export interface ScheduleRunSummary {
  at: Timestamp
  actor?: string
  jobs: number
  queued: number
  running: number
  succeeded: number
  failed: number
  canceled: number
  analyzers: string[]
  startedAt?: Timestamp
  finishedAt?: Timestamp
  failures: { id: string; analyzer: string; repo: RepoRef; error?: string }[]
}

const FAILURES = 5

/**
 * Groups a schedule's jobs into runs, newest first, at most `limit`. Jobs of one run share
 * `createdAt` because one tick (or one manual run) queues them together. `finishedAt` is set only
 * when no job of the run is queued or running.
 */
export function scheduleRuns(jobs: readonly Job[], limit = 10): ScheduleRunSummary[] {
  const byRun = new Map<string, Job[]>()
  for (const job of jobs) byRun.set(job.createdAt, [...(byRun.get(job.createdAt) ?? []), job])
  return [...byRun]
    .toSorted(([a], [b]) => b.localeCompare(a))
    .slice(0, limit)
    .map(([at, run]) => {
      const count = (status: Job['status']) => run.filter((job) => job.status === status).length
      const starts = run.flatMap((job) => (job.startedAt ? [job.startedAt] : [])).toSorted()
      const ends = run.flatMap((job) => (job.finishedAt ? [job.finishedAt] : [])).toSorted()
      const open = count('queued') + count('running')
      const actor = run.find((job) => job.actor)?.actor
      return {
        at,
        ...(actor ? { actor } : {}),
        jobs: run.length,
        queued: count('queued'),
        running: count('running'),
        succeeded: count('succeeded'),
        failed: count('failed'),
        canceled: count('canceled'),
        analyzers: [...new Set(run.map((job) => job.analyzer))].toSorted(),
        ...(starts[0] ? { startedAt: starts[0] } : {}),
        ...(open === 0 && ends.length ? { finishedAt: ends.at(-1) } : {}),
        failures: run
          .filter((job) => job.status === 'failed')
          .slice(0, FAILURES)
          .map((job) => ({
            id: job.id,
            analyzer: job.analyzer,
            repo: job.repo,
            ...(job.error ? { error: job.error } : {}),
          })),
      }
    })
}
