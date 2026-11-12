import type {
  CreateJobInput,
  GroupMatch,
  Job,
  JobAnalyzerView,
  JobAttempt,
  JobStep,
  JobSummary,
  JobStats,
  JobTargetView,
  JobWait,
  JobWaitKind,
  JobWorkerView,
  ScheduleRun,
  WaitReason,
} from '@holtkeeper/api'

import { formatUsd } from './ai-usage.ts'
import { formatDuration, formatRelative } from './format.ts'
import { type ScopeView, inView } from './home-scope.ts'
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

const statusTones: Record<
  JobStatus,
  'default' | 'info' | 'success' | 'warning' | 'danger' | 'code'
> = {
  queued: 'default',
  running: 'info',
  succeeded: 'success',
  failed: 'danger',
  blocked: 'code',
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

/** Label of an attempt for the attempt strip, e.g. `#2 Failed`. */
export const attemptLabel = (attempt: Pick<JobAttempt, 'n' | 'status'>): string =>
  `#${attempt.n} ${jobStatusLabel(attempt.status)}`

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
  tone: 'default' | 'info' | 'success' | 'danger' | 'warning' | 'code'
} {
  if (run.running > 0) return { label: 'Running', tone: 'info' }
  if (run.queued > 0) return { label: 'Queued', tone: 'default' }
  if (run.failed > 0)
    return { label: run.failed === run.jobs ? 'Failed' : 'Partly failed', tone: 'danger' }
  if (run.blocked > 0)
    return {
      label: run.blocked === run.jobs ? 'Blocked by budget' : 'Partly blocked by budget',
      tone: 'code',
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
 * The `repos` filter of a scope position: every target in the home groups for *My teams*, in the
 * group for a group position; `undefined` (no filter) for *All I can see* or before targets loaded.
 */
export function jobScopeRepos(
  view: ScopeView,
  targets: readonly JobTargetView[] | undefined,
  homeGroups: readonly GroupMatch[],
): string[] | undefined {
  if (view === 'all' || !targets) return undefined
  return targets
    .filter((target) => inView(view, homeGroups, target.groups))
    .map((target) => target.repo)
}

/** A wait reason in a short sentence, times relative to `now`, analyzers named by `label`. */
export function waitReasonText(
  reason: WaitReason,
  now: Date = new Date(),
  label: (kind: string) => string = (kind) => kind,
): string {
  switch (reason.kind) {
    case 'retry':
      return `Retries ${formatRelative(reason.at, now)} after attempt ${reason.attempt} failed`
    case 'scheduled':
      return `Not due before ${formatRelative(reason.at, now)}`
    case 'same-analyzer':
      return `A ${label(reason.analyzer)} job already runs on this repository`
    case 'exclusive-self':
      return `Changes the repository, so it waits for ${reason.running} running job${reason.running === 1 ? '' : 's'} there`
    case 'exclusive':
      return `The exclusive ${label(reason.analyzer)} job ${reason.state === 'running' ? 'runs' : 'is queued ahead'} on this repository`
    default:
      return `Waits for ${label(reason.analyzer)} on this repository, whose results it reads`
  }
}

/**
 * The one-line wait hint of a queued run: its first reason (with how many more), or the free
 * worker slot it waits for with the due runs ahead of it.
 */
export function waitHintText(
  wait: JobWait,
  now: Date = new Date(),
  label?: (kind: string) => string,
): string {
  const [first, ...rest] = wait.reasons
  if (!first)
    return wait.ahead
      ? `Waits for a free worker slot, ${wait.ahead} ahead`
      : 'Waits for a free worker slot'
  const text = waitReasonText(first, now, label)
  return rest.length ? `${text} (+${rest.length} more)` : text
}

const waitKindPhrases: Record<JobWaitKind, readonly [string, string]> = {
  capacity: ['waits for a free worker slot', 'wait for a free worker slot'],
  retry: ['waits to retry a failed attempt', 'wait to retry a failed attempt'],
  scheduled: ['is not due yet', 'are not due yet'],
  'same-analyzer': [
    'waits for the same analyzer on its repository',
    'wait for the same analyzer on their repository',
  ],
  'exclusive-self': ['waits for its repository to go idle', 'wait for their repository to go idle'],
  exclusive: [
    'waits for an exclusive job on its repository',
    'wait for an exclusive job on their repository',
  ],
  after: ['waits for results it reads', 'wait for results they read'],
}

/** A bucket of `JobStats.waits` as words, e.g. `5 wait for a free worker slot`. */
export function waitKindText(kind: JobWaitKind, count: number): string {
  const phrases = waitKindPhrases[kind] ?? [`waits: ${kind}`, `wait: ${kind}`]
  return `${count} ${count === 1 ? phrases[0] : phrases[1]}`
}

/** The buckets of `JobStats.waits` with runs in them, largest first. */
export const waitBuckets = (stats: Pick<JobStats, 'waits'>) =>
  stats.waits.reasons.filter((bucket) => bucket.count > 0).toSorted((a, b) => b.count - a.count)

/** One figure of the queue strip; shaped to fit a `StripCell`. */
export interface QueueFigure {
  value: string | number
  label: string
  prefix?: string
  tone?: 'info' | 'danger' | 'warning' | 'code'
  caption?: string
  end?: boolean
}

const optionalMs = (ms: number | undefined) => (ms === undefined ? '—' : formatDuration(ms))

/**
 * The queue at a glance from `GET /api/jobs/stats`: busy workers (when the stats list them), the
 * queued and running runs with what the running ones spent, the claim delay, and failed and
 * blocked runs of the stats window.
 */
export function queueFigures(stats: JobStats): QueueFigure[] {
  const workers = stats.workers
  const busy = workers?.filter((worker) => worker.running > 0).length ?? 0
  return [
    ...(workers
      ? [{ prefix: 'Workers busy', value: `${busy} / ${workers.length}`, label: '' }]
      : []),
    { value: stats.queue.queued, label: 'queued' },
    {
      value: stats.queue.running,
      label: 'running',
      tone: 'info',
      ...(stats.running.costUsd !== undefined &&
        stats.running.costUsd > 0 && {
          caption: `· ${formatUsd(stats.running.costUsd)} so far`,
        }),
    },
    {
      prefix: 'Claim delay p50',
      value: optionalMs(stats.claimLatency.p50Ms),
      label: '',
      caption: `· p95 ${optionalMs(stats.claimLatency.p95Ms)}`,
    },
    {
      value: stats.queue.failed,
      label: `failed in ${stats.windowHours} h`,
      tone: 'danger',
      end: true,
    },
    { value: stats.queue.blocked, label: 'blocked by budget', tone: 'code' },
  ]
}

/** A live worker in words: busy with how many runs, or idle. */
export const workerStateText = (worker: Pick<JobWorkerView, 'running'>): string =>
  worker.running > 0 ? `Busy · ${worker.running} ${worker.running === 1 ? 'run' : 'runs'}` : 'Idle'

/** Cost of a run for the Cost column: `—` without recorded agent runs. */
export const runCostText = (costUsd: number | undefined): string =>
  costUsd === undefined ? '—' : formatUsd(costUsd)

/** What a run spent against its cap, e.g. `$0.42 of $2.00 cap`; the cost alone without one. */
export const costCapText = (costUsd: number, capUsd?: number): string =>
  capUsd === undefined ? formatUsd(costUsd) : `${formatUsd(costUsd)} of ${formatUsd(capUsd)} cap`

/** Share of the cap spent in percent, 0 to 100; `undefined` without a positive cap. */
export const costCapShare = (costUsd: number, capUsd?: number): number | undefined =>
  capUsd === undefined || capUsd <= 0
    ? undefined
    : Math.min(100, Math.max(0, (costUsd / capUsd) * 100))

/** Milliseconds from a run becoming due to its claim; `undefined` before it started. */
export function claimDelay(job: Pick<JobSummary, 'runAfter' | 'startedAt'>): number | undefined {
  if (!job.startedAt) return undefined
  return Math.max(0, Date.parse(job.startedAt) - Date.parse(job.runAfter))
}

/** The Started cell: how long a queued run has waited (or when it is due), else when it started. */
export function runStartedText(
  job: Pick<JobSummary, 'status' | 'createdAt' | 'runAfter' | 'startedAt'>,
  now: Date = new Date(),
): string {
  if (job.status === 'queued') {
    if (Date.parse(job.runAfter) > now.getTime()) return `due ${formatRelative(job.runAfter, now)}`
    return `waiting ${formatDuration(now.getTime() - Date.parse(job.createdAt))}`
  }
  return formatRelative(job.startedAt ?? job.createdAt, now)
}

const firstLine = (text: string) => text.split('\n', 1)[0]?.trim() ?? ''

/** The line under a run's analyzer and how it reads. */
export interface RunSubline {
  text: string
  tone: 'muted' | 'warning' | 'danger'
}

/**
 * The line under a run in the list: the wait hint of a queued run, the budget stop of a blocked
 * one, the failure of a failed one, and for a running or finished run with earlier attempts what
 * the last failed attempt hit. `undefined` when there is nothing to add.
 */
export function runSubline(
  job: Pick<JobSummary, 'status' | 'error' | 'errorSignature' | 'attemptsHistory'>,
  wait?: JobWait,
  now: Date = new Date(),
  label?: (kind: string) => string,
): RunSubline | undefined {
  switch (job.status) {
    case 'queued':
      return wait ? { text: waitHintText(wait, now, label), tone: 'muted' } : undefined
    case 'blocked':
      return { text: 'Stopped by the AI budget; not retried', tone: 'warning' }
    case 'failed':
      return {
        text: job.errorSignature || firstLine(job.error ?? '') || 'Failed without a message',
        tone: 'danger',
      }
    default: {
      const failed = job.attemptsHistory.findLast((attempt) => attempt.status === 'failed')
      if (!failed) return undefined
      const cause = failed.error
        ? firstLine(failed.error)
        : failed.step
          ? `failed in ${failed.step}`
          : 'failed'
      return { text: `Attempt ${failed.n}: ${cause}`, tone: 'muted' }
    }
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

/** Search params of Ops › Runs. */
export interface JobsSearch {
  repo?: string
  status?: string
  analyzer?: string
  trigger?: string
  schedule?: string
  signature?: string
  /** The segment: `failures` or `queue`; anything else is All. */
  view?: string
  /** Search text over id, repository and analyzer of the loaded runs. */
  q?: string
}

const jobsSearchKeys = [
  'q',
  'repo',
  'status',
  'analyzer',
  'trigger',
  'schedule',
  'signature',
  'view',
] as const satisfies readonly (keyof JobsSearch)[]

/** Runs search params from the URL: known keys with non-empty string values only. */
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

/** A segment of Ops › Runs: every run, failed runs, or the queue. */
export type RunsSegment = 'all' | 'failures' | 'queue'

/** The segment the search params pick. */
export const runsSegment = (search: Pick<JobsSearch, 'view'>): RunsSegment =>
  search.view === 'failures' ? 'failures' : search.view === 'queue' ? 'queue' : 'all'

/** `search` switched to `segment`; the status filter goes, since Failures and Queue fix it. */
export const runsSegmentWith = (search: JobsSearch, segment: RunsSegment): JobsSearch =>
  jobsSearchWith(search, { view: segment === 'all' ? undefined : segment, status: undefined })

/**
 * The list filters of the search params: the segment fixes the status (Failures `failed`, Queue
 * `queued`), All takes a known `status`; unknown triggers are dropped; `q` is trimmed and left to
 * the server to match. Repository and scope are added by the page.
 */
export function runsFilter(search: JobsSearch): {
  status?: JobStatus
  trigger?: JobTrigger
  analyzer?: string
  schedule?: string
  signature?: string
  q?: string
} {
  const segment = runsSegment(search)
  const q = search.q?.trim()
  const status =
    segment === 'failures'
      ? 'failed'
      : segment === 'queue'
        ? 'queued'
        : isJobStatus(search.status)
          ? search.status
          : undefined
  return {
    ...(status && { status }),
    ...(isJobTrigger(search.trigger) && { trigger: search.trigger }),
    ...(search.analyzer && { analyzer: search.analyzer }),
    ...(search.schedule && { schedule: search.schedule }),
    ...(search.signature && { signature: search.signature }),
    ...(q && { q }),
  }
}

/** A run's options in one line: the first two as `key: value`, then how many there are. */
export function optionsSummary(options: Record<string, unknown>): string {
  const entries = Object.entries(options)
  const shown = entries
    .slice(0, 2)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
  return entries.length > 2
    ? [...shown, `${entries.length} options`].join(' · ')
    : shown.join(' · ')
}

const modeLabels: Record<'host' | 'mise' | 'container', string> = {
  host: 'host mode',
  mise: 'mise mode',
  container: 'container mode',
}

/** Where a run's commands ran, in words, e.g. `mise mode`. */
export const executionModeLabel = (mode: 'host' | 'mise' | 'container'): string =>
  modeLabels[mode] ?? mode
