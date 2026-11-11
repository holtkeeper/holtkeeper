import { formatDuration } from './stats.ts'
import type { CiJobsData, CiProblem, CiProblemKind, JobStats } from './types.ts'

/** Failure rate, in percent, from which a job counts as failing. */
const FAILING_RATE = 10
/** Pipelines that passed only on retry from which a job counts as flaky. */
const FLAKY_PIPELINES = 2

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const dayLabel = (at: string) => {
  const date = new Date(at)
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`
}

/**
 * The problems of one job: `slower` when its trend is, `failing` when at least 10% of its final
 * attempts fail (twice or more, jobs allowed to fail never), `flaky` when two or more pipelines
 * passed only on retry. Empty for a healthy job.
 */
export function jobProblems(job: JobStats): CiProblemKind[] {
  const kinds: CiProblemKind[] = []
  if (!job.allowFailure && job.failures >= 2 && (job.failureRate ?? 0) >= FAILING_RATE)
    kinds.push('failing')
  if (job.trend === 'slower') kinds.push('slower')
  if (job.flaky >= FLAKY_PIPELINES) kinds.push('flaky')
  return kinds
}

function reason(job: JobStats, kind: CiProblemKind, data: CiJobsData): string {
  if (kind === 'failing') return `fails in ${job.failureRate ?? 0}% of runs`
  if (kind === 'flaky')
    return `passed only on retry in ${job.flaky} pipelines, retried in ${job.retryRate}% of them`
  const since = job.changePoint
    ? `since ${dayLabel(job.changePoint.at)}`
    : `in the last ${data.options.recentDays} days`
  return `+${Math.round(job.change ?? 0)}% ${since} (${formatDuration(job.baselineMedian ?? 0)} → ${formatDuration(job.recentMedian ?? 0)})`
}

const weeklyCost = (job: JobStats) =>
  ((job.recentMedian ?? 0) - (job.baselineMedian ?? 0)) * job.runs

const worstFirst: Record<CiProblemKind, (a: JobStats, b: JobStats) => number> = {
  failing: (a, b) => (b.failureRate ?? 0) - (a.failureRate ?? 0) || b.failures - a.failures,
  slower: (a, b) => weeklyCost(b) - weeklyCost(a),
  flaky: (a, b) => b.flaky - a.flaky,
}

/**
 * At most `limit` problem jobs, taking the worst failing, slower and flaky job in turn so one kind
 * cannot crowd out the others; a job with several problems appears once.
 */
export function problemJobs(data: CiJobsData, limit = 5): CiProblem[] {
  const queues = (['failing', 'slower', 'flaky'] as const).map((kind) => ({
    kind,
    jobs: data.jobs
      .filter((job) => jobProblems(job).includes(kind))
      .toSorted((a, b) => worstFirst[kind](a, b) || a.name.localeCompare(b.name)),
  }))
  const picked: CiProblem[] = []
  const seen = new Set<string>()
  while (picked.length < limit && queues.some((queue) => queue.jobs.length)) {
    for (const queue of queues) {
      if (picked.length >= limit) break
      let job = queue.jobs.shift()
      while (job && seen.has(job.name)) job = queue.jobs.shift()
      if (!job) continue
      seen.add(job.name)
      picked.push({
        job: job.name,
        stage: job.stage,
        kind: queue.kind,
        reason: reason(job, queue.kind, data),
        href: queue.kind === 'slower' ? (job.changePoint?.href ?? job.last.href) : job.last.href,
      })
    }
  }
  return picked
}
