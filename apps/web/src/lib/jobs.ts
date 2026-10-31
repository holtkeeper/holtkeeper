import type { CreateJobInput, Job, JobAnalyzerView, JobSummary, ScheduleRun } from '@holtkeeper/api'

import { repoKey } from './repo.ts'

export type JobStatus = Job['status']
export type JobTrigger = Job['trigger']

/** Every job status, in lifecycle order. */
export const jobStatuses = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
] as const satisfies readonly JobStatus[]

const statusLabels: Record<JobStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  canceled: 'Canceled',
}

const statusTones: Record<JobStatus, 'default' | 'accent' | 'success' | 'danger'> = {
  queued: 'default',
  running: 'accent',
  succeeded: 'success',
  failed: 'danger',
  canceled: 'default',
}

const triggerLabels: Record<JobTrigger, string> = {
  schedule: 'Schedule',
  manual: 'Manual',
  webhook: 'Webhook',
  tag: 'Tag',
  push: 'Push',
  poll: 'Poll',
}

/** Human label of a status. */
export const jobStatusLabel = (status: JobStatus): string => statusLabels[status] ?? status

/** Chip tone of a status. */
export const jobStatusTone = (status: JobStatus) => statusTones[status] ?? 'default'

/** Human label of what queued a job. */
export const jobTriggerLabel = (trigger: JobTrigger): string => triggerLabels[trigger] ?? trigger

/** Whether `value` is a known status, for parsing search params. */
export const isJobStatus = (value: string | undefined): value is JobStatus =>
  value !== undefined && (jobStatuses as readonly string[]).includes(value)

/** Whether the job has not finished yet. */
export const isActiveJob = (job: Pick<JobSummary, 'status'>): boolean =>
  job.status === 'queued' || job.status === 'running'

/** Whether the job can still be cancelled. */
export const canCancelJob = (job: Pick<JobSummary, 'status'>): boolean => isActiveJob(job)

/** Input that queues the same analyzer on the same target, ref and options as `job`. */
export const rerunJobInput = (
  job: Pick<JobSummary, 'analyzer' | 'repo' | 'group' | 'ref' | 'options'>,
): CreateJobInput => ({
  analyzer: job.analyzer,
  ...(job.group !== undefined ? { group: job.group } : { repo: repoKey(job.repo) }),
  ...(job.ref ? { ref: job.ref } : {}),
  ...(Object.keys(job.options).length ? { options: job.options } : {}),
})

/**
 * Milliseconds the latest attempt ran: until `finishedAt`, or until `now` while running;
 * `undefined` when it never started.
 */
export function jobDuration(
  job: Pick<JobSummary, 'status' | 'startedAt' | 'finishedAt'>,
  now: Date = new Date(),
): number | undefined {
  if (!job.startedAt) return undefined
  const start = new Date(job.startedAt).getTime()
  const end = job.finishedAt
    ? new Date(job.finishedAt).getTime()
    : job.status === 'running'
      ? now.getTime()
      : undefined
  return end === undefined ? undefined : Math.max(0, end - start)
}

/**
 * Analyzers that fit a fixed target: group-scope ones for a group, repo-scope ones for a
 * repository, all of them when there is no target.
 */
export function analyzersFor(
  analyzers: readonly JobAnalyzerView[],
  target: { repo?: unknown; group?: string | undefined },
): JobAnalyzerView[] {
  if (target.group !== undefined) return analyzers.filter((a) => a.scope === 'group')
  if (target.repo !== undefined) return analyzers.filter((a) => a.scope === 'repo')
  return [...analyzers]
}

/** Label of an analyzer kind, the kind itself when it is unknown. */
export const analyzerLabel = (analyzers: readonly JobAnalyzerView[], kind: string): string =>
  analyzers.find((a) => a.kind === kind)?.label ?? kind

/** Overall state of a schedule run: unfinished, any failure, all canceled, or all done. */
export function scheduleRunState(run: Pick<ScheduleRun, 'jobs' | JobStatus>): {
  label: string
  tone: 'default' | 'accent' | 'success' | 'danger' | 'warning'
} {
  if (run.running > 0) return { label: 'Running', tone: 'accent' }
  if (run.queued > 0) return { label: 'Queued', tone: 'default' }
  if (run.failed > 0)
    return { label: run.failed === run.jobs ? 'Failed' : 'Partly failed', tone: 'danger' }
  if (run.canceled === run.jobs) return { label: 'Canceled', tone: 'default' }
  if (run.canceled > 0) return { label: 'Partly canceled', tone: 'warning' }
  return { label: 'Succeeded', tone: 'success' }
}

/** Share of each status in a run, in lifecycle order, for a stacked bar; zero shares left out. */
export function scheduleRunShares(
  run: Pick<ScheduleRun, 'jobs' | JobStatus>,
): { status: JobStatus; count: number; percent: number }[] {
  return jobStatuses
    .map((status) => ({
      status,
      count: run[status],
      percent: run.jobs ? (run[status] / run.jobs) * 100 : 0,
    }))
    .filter((share) => share.count > 0)
}
