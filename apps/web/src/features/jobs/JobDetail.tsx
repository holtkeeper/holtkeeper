import type { Job, JobAttempt, JobStep, JobWhy } from '@holtkeeper/api'
import { Link, useNavigate, useRouter } from '@tanstack/react-router'
import { Info, type LucideIcon, RotateCw, Square } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import {
  useAnalysis,
  useJobLog,
  useJobMutations,
  useJobRuns,
  useJobWhy,
} from '../../api/queries.ts'
import { formatUsd } from '../../lib/ai-usage.ts'
import { formatDateTime, formatDuration, formatRef, formatRelative } from '../../lib/format.ts'
import {
  attemptDuration,
  attemptLabel,
  canCancelJob,
  claimDelay,
  costCapShare,
  costCapText,
  executionModeLabel,
  isActiveJob,
  jobDuration,
  jobStatusLabel,
  jobStatusTone,
  jobTriggerLabel,
  logLineTime,
  optionsSummary,
  rerunJobInput,
  stepBars,
  stepDuration,
  waitReasonText,
} from '../../lib/jobs.ts'
import { personOf } from '../../lib/people.ts'
import { repoSplat } from '../../lib/repo.ts'
import {
  Avatar,
  Button,
  ConfirmDialog,
  Dot,
  EmptyState,
  ErrorState,
  GroupName,
  KeyValue,
  type KeyValueRow,
  notify,
  Placeholder,
  SegmentBar,
  SegmentedTabs,
  Tag,
  Tooltip,
} from '../../ui/index.ts'
import { MetricCard } from '../reports/MetricCard.tsx'
import { useSession } from '../shell/session.ts'
import { JobAgentRuns } from './JobAgentRuns.tsx'
import { JobLogView, LOG_TAIL } from './JobLogView.tsx'

function Time({ at, now }: { at: string | undefined; now: Date }) {
  if (!at) return <span className="text-dim">—</span>
  return (
    <Tooltip content={formatDateTime(at)}>
      <time tabIndex={0} dateTime={at}>
        {formatRelative(at, now)}
      </time>
    </Tooltip>
  )
}

function Section({
  title,
  aside,
  children,
}: {
  title: string
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-xs font-medium text-muted">
        {title}
        {aside ? <span className="ms-auto flex items-center gap-2">{aside}</span> : null}
      </h3>
      {children}
    </section>
  )
}

/** The job's analyzer target: a group page or a repository in monospace. */
function JobTarget({ job }: { job: Pick<Job, 'repo' | 'group'> }) {
  return job.group !== undefined ? (
    <Link
      to="/repos/groups/$groupId"
      params={{ groupId: job.group }}
      search={{}}
      className="hover:underline"
    >
      Group <GroupName group={job.group} />
    </Link>
  ) : (
    <Link
      to="/repos/$"
      params={{ _splat: repoSplat(job.repo) }}
      className="mono text-xs hover:underline"
    >
      {job.repo.path}
    </Link>
  )
}

const stepTone = {
  running: 'var(--info)',
  succeeded: 'var(--ok)',
  failed: 'var(--bad)',
} as const

function StepsTimeline({
  steps,
  start,
  end,
}: {
  steps: readonly JobStep[]
  start: string
  end: string
}) {
  if (!steps.length) return <p className="text-xs text-muted">No steps recorded yet.</p>
  return (
    <ol className="flex flex-col gap-1" aria-label="Steps">
      {stepBars(steps, start, end).map(({ step, left, width }) => (
        <li
          key={step.line}
          className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)_64px] items-center gap-3 text-xs"
        >
          <span
            className={`truncate ${step.status === 'failed' ? 'text-bad' : ''}`}
            style={{ paddingLeft: `${step.depth * 12}px` }}
            title={step.name}
          >
            {step.status === 'failed' ? '✗ ' : step.status === 'running' ? '▸ ' : ''}
            {step.name}
          </span>
          <span className="relative h-1.5 rounded-sm bg-line">
            <span
              className="absolute inset-y-0 rounded-sm"
              style={{
                left: `${left}%`,
                width: `${width}%`,
                background: stepTone[step.status],
              }}
            />
          </span>
          <span className="mono text-right text-muted tabular">{stepDuration(step)}</span>
        </li>
      ))}
    </ol>
  )
}

/** A labelled button of a job's actions, shaped for page headers and side sheet rows. */
interface JobAction {
  label: string
  icon: LucideIcon
  onPress: () => void
}

/**
 * What can be done with a job, as the viewer's permissions allow: run it again, cancel it (behind
 * a confirmation, rendered by `dialog`) and the app path of its result.
 */
export function useJobActions(
  job: Job,
  label: string,
): {
  runAgain?: JobAction
  cancel?: JobAction
  resultHref?: string
  dialog: ReactNode
} {
  const { can } = useSession()
  const { cancel, create } = useJobMutations()
  const navigate = useNavigate()
  const router = useRouter()
  const [confirm, setConfirm] = useState(false)
  const runnable = can('analyses:run')
  return {
    ...(!isActiveJob(job) && runnable
      ? {
          runAgain: {
            label: 'Run again',
            icon: RotateCw,
            onPress: () =>
              create.mutate(rerunJobInput(job), {
                onSuccess: (next) => {
                  notify.success('Run queued', label)
                  void navigate({ to: '/ops/runs/$jobId', params: { jobId: next.id } })
                },
                onError: (error) => notify.error('Run not queued', messageOf(error)),
              }),
          },
        }
      : {}),
    ...(canCancelJob(job) && runnable
      ? { cancel: { label: 'Cancel run', icon: Square, onPress: () => setConfirm(true) } }
      : {}),
    ...(job.analysisId
      ? {
          resultHref: router.buildLocation({
            to: '/analyses/$id',
            params: { id: job.analysisId },
            search: {},
          }).href,
        }
      : {}),
    dialog: (
      <ConfirmDialog
        isOpen={confirm}
        onOpenChange={setConfirm}
        title="Cancel this run?"
        confirmLabel="Cancel run"
        isPending={cancel.isPending}
        onConfirm={() =>
          cancel.mutate(job.id, {
            onSuccess: () => {
              setConfirm(false)
              notify.success('Run canceled', label)
            },
            onError: (error) => notify.error('Run not canceled', messageOf(error)),
          })
        }
      >
        {job.status === 'running'
          ? 'The running analyzer is stopped and its partial work is discarded.'
          : 'The run leaves the queue and never starts.'}
      </ConfirmDialog>
    ),
  }
}

/** Tabs of a run: steps with facts, the log, what it found, and what it cost. */
export type RunTab = 'steps' | 'logs' | 'findings' | 'cost'

function WhyNotice({ job, why, now }: { job: Job; why: JobWhy | undefined; now: Date }) {
  const { canGlobal } = useSession()
  if (!why) return null
  const automation = (job.trigger !== 'manual' || job.schedule) && canGlobal('settings:read')
  return (
    <div className="flex gap-2.5 rounded-[7px] border border-line bg-raise px-3 py-2.5 text-[12.5px]">
      <Info aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted" />
      <div className="flex min-w-0 flex-col gap-1.5">
        <p>
          {why.origin}.{why.outcome ? ` ${why.outcome}.` : ''}
        </p>
        {why.wait ? (
          <ul className="flex flex-col gap-0.5 text-muted">
            {why.wait.reasons.length ? (
              why.wait.reasons.map((reason, index) => (
                <li key={index}>{waitReasonText(reason, now)}.</li>
              ))
            ) : (
              <li>Waits for a free worker slot.</li>
            )}
            <li className="tabular">
              {why.wait.ahead} due {why.wait.ahead === 1 ? 'run' : 'runs'} ahead in the queue.
            </li>
          </ul>
        ) : null}
        {automation || job.errorSignature ? (
          <span className="flex flex-wrap gap-3 text-xs">
            {automation ? (
              <Link
                to="/ops/automation"
                search={{ job: job.id }}
                className="text-accent hover:underline"
              >
                Show on Automation
              </Link>
            ) : null}
            {job.errorSignature ? (
              <Link
                to="/ops/runs"
                search={{ signature: job.errorSignature, view: 'failures' }}
                className="text-muted hover:underline"
              >
                Runs with the same failure
              </Link>
            ) : null}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function ErrorBox({ job }: { job: Job }) {
  if (!job.error) return null
  const blocked = job.status === 'blocked'
  return (
    <div
      className={`flex flex-col gap-1.5 rounded-[7px] border px-3 py-2 ${blocked ? 'border-warn/30 bg-warn/10' : 'border-bad/30 bg-bad/10'}`}
    >
      <p className={`text-xs font-medium ${blocked ? 'text-warn' : 'text-bad'}`}>
        {blocked
          ? 'Stopped by the AI budget; not retried'
          : job.status === 'failed'
            ? 'Failed'
            : 'Last attempt failed'}
      </p>
      <pre className="max-h-40 overflow-auto font-mono text-[11.5px] whitespace-pre-wrap">
        {job.error}
      </pre>
    </div>
  )
}

function AttemptStrip({
  attempts,
  selected,
  onSelect,
}: {
  attempts: readonly JobAttempt[]
  selected: number
  onSelect: (n: number) => void
}) {
  if (attempts.length < 2) return null
  return (
    <SegmentedTabs
      aria-label="Attempt"
      selected={String(selected)}
      onSelect={(id) => onSelect(Number(id))}
      items={attempts.map((attempt) => ({
        id: String(attempt.n),
        label: (
          <span className="inline-flex items-center gap-1.5">
            <Dot tone={jobStatusTone(attempt.status)} />
            {attemptLabel(attempt)}
          </span>
        ),
      }))}
    />
  )
}

function AttemptLine({ entry, now }: { entry: JobAttempt; now: Date }) {
  const ran = attemptDuration(entry)
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      <Tag tone={jobStatusTone(entry.status)}>{jobStatusLabel(entry.status)}</Tag>
      <span>
        started <Time at={entry.startedAt} now={now} />
      </span>
      {ran !== undefined ? <span className="mono">{formatDuration(ran)}</span> : null}
      {entry.workerId ? <span className="mono">{entry.workerId}</span> : null}
      {entry.step ? <span className="text-bad">failed in {entry.step}</span> : null}
    </p>
  )
}

function LogTail({
  job,
  attempt,
  live,
  onOpen,
}: {
  job: Job
  attempt: number
  live: boolean
  onOpen?: () => void
}) {
  const log = useJobLog(job.id, attempt, live, LOG_TAIL)
  const lines = (log.data?.lines ?? []).slice(-8)
  if (!lines.length) return null
  return (
    <Section
      title="Log tail"
      aside={
        <>
          {live ? <Tag tone="info">live</Tag> : null}
          <span className="tabular text-dim">{log.data?.total ?? 0} lines</span>
          {onOpen ? (
            <Button size="sm" variant="ghost" onPress={onOpen}>
              Open Logs
            </Button>
          ) : null}
        </>
      }
    >
      <div
        role="log"
        className="overflow-hidden rounded-[7px] border border-line bg-sunk px-3 py-2 font-mono text-[11.5px] leading-relaxed"
      >
        {lines.map((line) => (
          <div
            key={line.n}
            className={`flex gap-3 ${line.level === 'error' || line.mark === 'fail' ? 'text-bad' : line.mark ? 'text-info' : ''}`}
          >
            <span className="w-16 shrink-0 text-dim tabular">{logLineTime(line.at)}</span>
            <span className="min-w-0 truncate">
              {line.mark === 'start'
                ? `▸ ${line.step ?? ''}`
                : line.mark === 'end'
                  ? `✓ ${line.step ?? ''}`
                  : line.text}
            </span>
          </div>
        ))}
      </div>
    </Section>
  )
}

function RunFacts({
  job,
  why,
  costUsd,
  now,
}: {
  job: Job
  why: JobWhy | undefined
  costUsd: number | undefined
  now: Date
}) {
  const [showOptions, setShowOptions] = useState(false)
  const actor = job.actor ? personOf(why?.people ?? {}, job.actor) : undefined
  const delay = claimDelay(job)
  const duration = jobDuration(job, now)
  const options = Object.keys(job.options).length ? job.options : undefined
  const rows: KeyValueRow[] = [
    {
      label: 'Trigger',
      value: job.schedule ? (
        <Link to="/ops/runs" search={{ schedule: job.schedule }} className="mono hover:underline">
          {job.schedule}
        </Link>
      ) : (
        jobTriggerLabel(job.trigger)
      ),
    },
    {
      label: 'Requested by',
      value: actor ? (
        <>
          <Avatar src={actor.avatarUrl} name={actor.name} size="xs" />
          <span className="truncate">{actor.name}</span>
        </>
      ) : (
        <span className="text-muted">
          {job.schedule ? 'Schedule, no person' : 'Automation, no person'}
        </span>
      ),
    },
    {
      label: 'Worker',
      value:
        job.workerId || why ? (
          <>
            {job.workerId ? <span className="mono">{job.workerId}</span> : null}
            {why ? <span className="text-muted">{executionModeLabel(why.mode)}</span> : null}
          </>
        ) : null,
    },
    {
      label: 'Attempts',
      value: (
        <span className="tabular">
          {job.attempts} of {job.maxAttempts}
        </span>
      ),
    },
    { label: 'Created', value: <Time at={job.createdAt} now={now} /> },
    {
      label: job.status === 'queued' ? 'Runs after' : 'Started',
      value: (
        <>
          <Time at={job.status === 'queued' ? job.runAfter : job.startedAt} now={now} />
          {delay !== undefined ? (
            <span className="text-muted">
              · claimed after <span className="mono">{formatDuration(delay)}</span>
            </span>
          ) : null}
        </>
      ),
    },
    { label: 'Finished', value: job.finishedAt ? <Time at={job.finishedAt} now={now} /> : null },
    {
      label: 'Duration',
      value:
        duration === undefined ? null : <span className="mono">{formatDuration(duration)}</span>,
    },
    {
      label: 'Cost',
      value:
        costUsd !== undefined || why?.costCapUsd !== undefined ? (
          <span className="mono">{costCapText(costUsd ?? 0, why?.costCapUsd)}</span>
        ) : null,
    },
    {
      label: 'Options',
      value: options ? (
        <>
          <span className="mono truncate text-muted">{optionsSummary(options)}</span>
          <Button size="sm" variant="ghost" onPress={() => setShowOptions(!showOptions)}>
            {showOptions ? 'Hide' : 'Show'}
          </Button>
        </>
      ) : null,
    },
  ]
  return (
    <Section title="Run">
      <KeyValue rows={rows} />
      {options && showOptions ? (
        <pre className="overflow-x-auto rounded-[7px] border border-line bg-sunk p-3 font-mono text-[11.5px]">
          {JSON.stringify(options, null, 2)}
        </pre>
      ) : null}
    </Section>
  )
}

function RunFindings({ job }: { job: Job }) {
  const analysis = useAnalysis(job.analysisId ?? '', undefined, job.analysisId !== undefined)
  const router = useRouter()
  if (!job.analysisId)
    return (
      <p className="text-xs text-muted">
        {isActiveJob(job) ? 'The run has not stored a result yet.' : 'This run stored no result.'}
      </p>
    )
  if (analysis.isPending) return <Placeholder className="h-32" />
  if (analysis.isError) return <ErrorState error={analysis.error} />
  const metrics = analysis.data.report.metrics
  const href = router.buildLocation({
    to: '/analyses/$id',
    params: { id: job.analysisId },
    search: {},
  }).href
  return (
    <Section
      title={analysis.data.report.title}
      aside={
        <a href={href} className="text-xs text-accent hover:underline">
          Open result
        </a>
      }
    >
      {metrics.length ? (
        <div className="grid grid-cols-2 gap-3">
          {metrics.map((metric) => (
            <MetricCard key={metric.id} metric={metric} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted">The result has no headline numbers.</p>
      )}
    </Section>
  )
}

function RunCost({ job, why }: { job: Job; why: JobWhy | undefined }) {
  const runs = useJobRuns(job.id, isActiveJob(job))
  if (runs.isPending) return <Placeholder className="h-24" />
  if (runs.isError) return <ErrorState error={runs.error} />
  const cap = why?.costCapUsd
  const share = costCapShare(runs.data.costUsd, cap)
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <p className="flex items-baseline gap-2">
          <span className="mono text-lg font-semibold tabular">{formatUsd(runs.data.costUsd)}</span>
          <span className="text-xs text-muted">
            {cap === undefined
              ? `${runs.data.runs.length} agent ${runs.data.runs.length === 1 ? 'run' : 'runs'}, no cap on this run`
              : `of ${formatUsd(cap)} cap`}
          </span>
        </p>
        {share !== undefined ? (
          <SegmentBar
            total={100}
            segments={[
              {
                value: share,
                tone: share >= 100 ? 'danger' : share >= 80 ? 'warning' : 'info',
                label: 'percent of the cap spent',
              },
            ]}
          />
        ) : null}
      </div>
      {runs.data.runs.length ? (
        <JobAgentRuns jobId={job.id} live={isActiveJob(job)} />
      ) : (
        <EmptyState
          title="No agent runs"
          description="This run used no model, so it cost nothing from the AI budget."
        />
      )}
    </div>
  )
}

/**
 * One run. **Steps**: why it ran (or what keeps it queued), its error, the attempt strip with the
 * picked attempt's step timeline and log tail, and the run facts (trigger, requester, worker and
 * execution mode, timings, cost against `costCapUsd`, options). **Logs**: the picked attempt's
 * log. **Findings**: the stored result's headline numbers. **Cost**: agent runs with their
 * transcripts. The side sheet shows one `tab`; the full page leaves it out and shows all.
 */
export function JobDetail({
  job,
  tab,
  onTab,
  costUsd,
}: {
  job: Job
  tab?: RunTab
  onTab?: (tab: RunTab) => void
  /** Cost of the run's agent runs, when known from the list. */
  costUsd?: number
}) {
  const [picked, setPicked] = useState<number>()
  const why = useJobWhy(job.id, job.status)
  const attempt = picked !== undefined && picked <= job.attempts ? picked : job.attempts
  const entry = job.attemptsHistory.find((item) => item.n === attempt)
  const live = attempt === job.attempts && job.status === 'running'
  const log = useJobLog(job.id, attempt, live, LOG_TAIL)
  const now = new Date()
  const show = (name: RunTab) => tab === undefined || tab === name

  return (
    <div className="flex flex-col gap-5">
      {show('steps') ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Tag tone={jobStatusTone(job.status)} dot>
              {jobStatusLabel(job.status)}
            </Tag>
            <JobTarget job={job} />
            {job.ref ? (
              <span className="mono text-xs text-muted" title={job.ref}>
                {formatRef(job.ref)}
              </span>
            ) : null}
            <span className="text-xs text-muted tabular">
              attempt {job.attempts} of {job.maxAttempts}
            </span>
          </div>
          {why.isError ? <ErrorState error={why.error} /> : null}
          <WhyNotice job={job} why={why.data} now={now} />
          <ErrorBox job={job} />
          <Section
            title="Attempt"
            aside={
              <AttemptStrip
                attempts={job.attemptsHistory}
                selected={attempt}
                onSelect={setPicked}
              />
            }
          >
            {entry ? (
              <>
                <AttemptLine entry={entry} now={now} />
                <StepsTimeline
                  steps={log.data?.steps ?? []}
                  start={entry.startedAt}
                  end={entry.finishedAt ?? now.toISOString()}
                />
              </>
            ) : (
              <p className="text-xs text-muted">The run has not started yet.</p>
            )}
          </Section>
          {entry && tab !== undefined ? (
            <LogTail
              job={job}
              attempt={attempt}
              live={live}
              {...(onTab && { onOpen: () => onTab('logs') })}
            />
          ) : null}
          <RunFacts job={job} why={why.data} costUsd={costUsd} now={now} />
        </>
      ) : null}
      {show('logs') ? (
        <Section
          title="Log"
          aside={
            <>
              {tab === 'logs' ? (
                <AttemptStrip
                  attempts={job.attemptsHistory}
                  selected={attempt}
                  onSelect={setPicked}
                />
              ) : null}
              {live ? <Tag tone="info">live</Tag> : null}
            </>
          }
        >
          <JobLogView key={attempt} jobId={job.id} attempt={attempt} live={live} />
        </Section>
      ) : null}
      {show('findings') ? <RunFindings job={job} /> : null}
      {show('cost') ? (
        tab === undefined ? (
          <Section title="Cost">
            <RunCost job={job} why={why.data} />
          </Section>
        ) : (
          <RunCost job={job} why={why.data} />
        )
      ) : null}
    </div>
  )
}
