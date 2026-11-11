import type {
  CreateJobInput,
  GroupMatch,
  Job,
  JobAnalyzerView,
  JobAttempt,
  JobStep,
  JobSummary,
  JobTargetView,
  ScheduleRun,
  WaitReason,
} from '@holtkeeper/api'

import { formatDuration, formatRelative } from './format.ts'
import { type ScopeView, inHomeGroups } from './home-scope.ts'
import { repoKey } from './repo.ts'

export type JobStatus = Job['status']
export type JobTrigger = Job['trigger']

/** Every job status, in lifecycle order. */
export const jobStatuses = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'blocked',
  'canceled',
] as const satisfies readonly JobStatus[]

const statusLabels: Record<JobStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  blocked: 'Blocked by budget',
  canceled: 'Canceled',
}

const statusTones: Record<JobStatus, 'default' | 'accent' | 'success' | 'warning' | 'danger'> = {
  queued: 'default',
  running: 'accent',
  succeeded: 'success',
  failed: 'danger',
  blocked: 'warning',
  canceled: 'default',
}

const triggerLabels: Record<JobTrigger, string> = {
  schedule: 'Schedule',
  manual: 'Manual',
  command: 'Command',
  webhook: 'Webhook',
  tag: 'Tag',
  push: 'Push',
  poll: 'Poll',
  'new-repo': 'New repository',
  freshness: 'Freshness',
}

/** Every trigger, for the trigger filter. */
export const jobTriggers = [
  'schedule',
  'manual',
  'command',
  'webhook',
  'tag',
  'push',
  'poll',
  'new-repo',
  'freshness',
] as const satisfies readonly JobTrigger[]

/** Whether `value` is a known trigger, for parsing search params. */
export const isJobTrigger = (value: string | undefined): value is JobTrigger =>
  value !== undefined && (jobTriggers as readonly string[]).includes(value)

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

/** Milliseconds an attempt ran; `undefined` while it still runs. */
export const attemptDuration = (attempt: Pick<JobAttempt, 'startedAt' | 'finishedAt'>) =>
  attempt.finishedAt
    ? Math.max(0, new Date(attempt.finishedAt).getTime() - new Date(attempt.startedAt).getTime())
    : undefined

const attemptMarks: Record<JobAttempt['status'], string> = {
  running: '…',
  succeeded: '✓',
  failed: '✗',
  blocked: '!',
  canceled: '–',
}

/** Short label of an attempt for a switcher, e.g. `#2 ✗`. */
export const attemptLabel = (attempt: Pick<JobAttempt, 'n' | 'status'>): string =>
  `#${attempt.n} ${attemptMarks[attempt.status] ?? ''}`.trim()

/** Wall-clock time of a log line, `HH:MM:SS` in the viewer's time zone. */
export const logLineTime = (at: string): string =>
  new Date(at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })

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

/** Overall state of a schedule run: unfinished, any failure, any blocked, all canceled, or all done. */
export function scheduleRunState(run: Pick<ScheduleRun, 'jobs' | JobStatus>): {
  label: string
  tone: 'default' | 'accent' | 'success' | 'danger' | 'warning'
} {
  if (run.running > 0) return { label: 'Running', tone: 'accent' }
  if (run.queued > 0) return { label: 'Queued', tone: 'default' }
  if (run.failed > 0)
    return { label: run.failed === run.jobs ? 'Failed' : 'Partly failed', tone: 'danger' }
  if (run.blocked > 0)
    return {
      label: run.blocked === run.jobs ? 'Blocked by budget' : 'Partly blocked by budget',
      tone: 'warning',
    }
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

/**
 * The `repos` filter of a scope position: every target in the home groups for *My team*, the rest
 * for *Other teams*; `undefined` (no filter) for *All I can see* or before targets loaded.
 */
export function jobScopeRepos(
  view: ScopeView,
  targets: readonly JobTargetView[] | undefined,
  homeGroups: readonly GroupMatch[],
): string[] | undefined {
  if (view === 'all' || !targets) return undefined
  const mine = view === 'mine'
  return targets
    .filter((target) => inHomeGroups(homeGroups, target.groups) === mine)
    .map((target) => target.repo)
}

/** A wait reason in a short sentence, times relative to `now`. */
export function waitReasonText(reason: WaitReason, now: Date = new Date()): string {
  switch (reason.kind) {
    case 'retry':
      return `Retries ${formatRelative(reason.at, now)} after attempt ${reason.attempt} failed`
    case 'scheduled':
      return `Not due before ${formatRelative(reason.at, now)}`
    case 'same-analyzer':
      return `A ${reason.analyzer} job already runs on this repository`
    case 'exclusive-self':
      return `Changes the repository, so it waits for ${reason.running} running job${reason.running === 1 ? '' : 's'} there`
    case 'exclusive':
      return `The exclusive ${reason.analyzer} job ${reason.state === 'running' ? 'runs' : 'is queued ahead'} on this repository`
    default:
      return `Waits for ${reason.analyzer} on this repository, whose results it reads`
  }
}

/** One step placed on its attempt's timeline: offset and width in percent of the attempt. */
export interface StepBar {
  step: JobStep
  left: number
  width: number
}

/**
 * Steps laid out on a timeline from `start` (the attempt's start) to `end` (its finish, or `now`
 * while running); a running step reaches the end, every bar keeps a visible minimum width.
 */
export function stepBars(steps: readonly JobStep[], start: string, end: string): StepBar[] {
  const from = Date.parse(start)
  const span = Math.max(1, Date.parse(end) - from)
  return steps.map((step) => {
    const offset = Math.max(0, Date.parse(step.startedAt) - from)
    const ms =
      step.ms ?? (step.status === 'running' ? Date.parse(end) - Date.parse(step.startedAt) : 0)
    const left = Math.min(100, (offset / span) * 100)
    return {
      step,
      left,
      width: Math.max(0.5, Math.min(100 - left, (Math.max(0, ms) / span) * 100)),
    }
  })
}

/** Duration of a step for display; `running` while it has none. */
export const stepDuration = (step: JobStep): string =>
  step.ms !== undefined ? formatDuration(step.ms) : step.status === 'running' ? 'running' : '—'

/** Distinct jobs by id in list order, for pages that may overlap at equal `createdAt`. */
export function uniqueJobs<T extends { id: string }>(pages: readonly (readonly T[])[]): T[] {
  const seen = new Set<string>()
  return pages.flat().filter((job) => !seen.has(job.id) && Boolean(seen.add(job.id)))
}

/** Search params of the Jobs page. */
export interface JobsSearch {
  repo?: string
  status?: string
  analyzer?: string
  trigger?: string
  schedule?: string
  signature?: string
  /** `failures` shows failed jobs grouped by cause. */
  view?: string
}

const jobsSearchKeys = [
  'repo',
  'status',
  'analyzer',
  'trigger',
  'schedule',
  'signature',
  'view',
] as const satisfies readonly (keyof JobsSearch)[]

/** Jobs page search params from the URL: known keys with non-empty string values only. */
export function parseJobsSearch(search: Record<string, unknown>): JobsSearch {
  const parsed: JobsSearch = {}
  for (const key of jobsSearchKeys) {
    const value = search[key]
    if (typeof value === 'string' && value) parsed[key] = value
  }
  return parsed
}

/** `search` with `patch` applied; keys set to `undefined` or empty are dropped. */
export const jobsSearchWith = (search: JobsSearch, patch: Partial<JobsSearch>): JobsSearch =>
  parseJobsSearch({ ...search, ...patch })
