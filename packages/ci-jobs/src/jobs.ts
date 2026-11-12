import { jobProblems } from './problems.ts'
import type { CiJobsData, CiOutcomes, CiProblemKind, JobStats } from './types.ts'

/** One job as the jobs table shows it. Durations are seconds. */
export interface CiJobTableRow {
  name: string
  stage: string
  runs: number
  outcomes: CiOutcomes
  median?: number
  p90?: number
  change?: number
  failureRate?: number
  flaky: number
  allowFailure: boolean
  problems: CiProblemKind[]
  last: JobStats['last']
}

/** The jobs table of one record: at most `limit` rows, and what every job of it adds up to. */
export interface CiJobTable {
  rows: CiJobTableRow[]
  /** Jobs of the record, rows left out included. */
  total: number
  /** Sums over every job of the record. */
  outcomes: CiOutcomes
}

const none = (): CiOutcomes => ({ success: 0, failed: 0, canceled: 0 })

const severity = (problems: readonly CiProblemKind[]) =>
  problems.includes('failing') ? 3 : problems.length ? 2 : 0

/**
 * The jobs of `data` as table rows, jobs with problems first (failing before the rest), then the
 * slowest median; at most `limit` rows. Jobs of records written before outcomes were counted
 * report zero outcomes.
 */
export function ciJobTable(data: CiJobsData, limit: number): CiJobTable {
  const outcomes = none()
  const rows = data.jobs.map((job): CiJobTableRow => {
    const counts = job.outcomes ?? none()
    for (const key of ['success', 'failed', 'canceled'] as const) outcomes[key] += counts[key]
    return {
      name: job.name,
      stage: job.stage,
      runs: job.runs,
      outcomes: counts,
      ...(job.duration.median === undefined ? {} : { median: job.duration.median }),
      ...(job.duration.p90 === undefined ? {} : { p90: job.duration.p90 }),
      ...(job.change === undefined ? {} : { change: job.change }),
      ...(job.failureRate === undefined ? {} : { failureRate: job.failureRate }),
      flaky: job.flaky,
      allowFailure: job.allowFailure,
      problems: jobProblems(job),
      last: job.last,
    }
  })
  const ordered = rows.toSorted(
    (a, b) =>
      severity(b.problems) - severity(a.problems) ||
      (b.median ?? -1) - (a.median ?? -1) ||
      a.name.localeCompare(b.name),
  )
  return { rows: ordered.slice(0, Math.max(0, limit)), total: rows.length, outcomes }
}
