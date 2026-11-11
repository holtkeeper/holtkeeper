import type { Job, JobStep } from '@holtkeeper/api'
import { Link, useNavigate } from '@tanstack/react-router'
import { FileText, RotateCw, Square } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useJobLog, useJobMutations, useJobWhy } from '../../api/queries.ts'
import { formatDateTime, formatDuration, formatRef, formatRelative } from '../../lib/format.ts'
import {
  attemptDuration,
  attemptLabel,
  canCancelJob,
  isActiveJob,
  jobDuration,
  jobStatusLabel,
  jobStatusTone,
  jobTriggerLabel,
  rerunJobInput,
  stepBars,
  stepDuration,
  waitReasonText,
} from '../../lib/jobs.ts'
import { personOf } from '../../lib/people.ts'
import { repoKey } from '../../lib/repo.ts'
import {
  Avatar,
  Button,
  ConfirmDialog,
  LinkButton,
  Segmented,
  Tag,
  Tooltip,
  notify,
} from '../../ui/index.ts'
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

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[11px] text-dim">{label}</dt>
      <dd className="min-w-0 truncate text-[13px]">{children}</dd>
    </div>
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
        {aside}
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
      Group {job.group}
    </Link>
  ) : (
    <Link
      to="/repos/view"
      search={{ repo: repoKey(job.repo) }}
      className="mono text-xs hover:underline"
    >
      {job.repo.path}
    </Link>
  )
}

const stepTone = { running: 'var(--info)', succeeded: 'var(--ok)', failed: 'var(--bad)' } as const

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
    <ol className="flex flex-col gap-1">
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
              style={{ left: `${left}%`, width: `${width}%`, background: stepTone[step.status] }}
            />
          </span>
          <span className="mono text-right text-muted tabular">{stepDuration(step)}</span>
        </li>
      ))}
    </ol>
  )
}

/** Open result, run again and cancel, as the viewer's permissions allow. */
export function JobActions({ job, label }: { job: Job; label: string }) {
  const { can } = useSession()
  const { cancel, create } = useJobMutations()
  const navigate = useNavigate()
  const [confirm, setConfirm] = useState(false)
  return (
    <>
      {job.analysisId ? (
        <LinkButton to="/analyses/$id" params={{ id: job.analysisId }} search={{}} size="sm">
          <FileText className="size-3.5" />
          Result
        </LinkButton>
      ) : null}
      {!isActiveJob(job) && can('analyses:run') ? (
        <Button
          variant="secondary"
          size="sm"
          isPending={create.isPending}
          onPress={() =>
            create.mutate(rerunJobInput(job), {
              onSuccess: (next) => {
                notify.success('Job queued', label)
                void navigate({ to: '/jobs/$jobId', params: { jobId: next.id } })
              },
              onError: (error) => notify.error('Job not queued', messageOf(error)),
            })
          }
        >
          <RotateCw className="size-3.5" />
          Run again
        </Button>
      ) : null}
      {canCancelJob(job) && can('analyses:run') ? (
        <Button variant="danger-soft" size="sm" onPress={() => setConfirm(true)}>
          <Square className="size-3.5" />
          Cancel
        </Button>
      ) : null}
      <ConfirmDialog
        isOpen={confirm}
        onOpenChange={setConfirm}
        title="Cancel this job?"
        confirmLabel="Cancel job"
        isPending={cancel.isPending}
        onConfirm={() =>
          cancel.mutate(job.id, {
            onSuccess: () => {
              setConfirm(false)
              notify.success('Job canceled', label)
            },
            onError: (error) => notify.error('Job not canceled', messageOf(error)),
          })
        }
      >
        {job.status === 'running'
          ? 'The running analyzer is stopped and its partial work is discarded.'
          : 'The job leaves the queue and never runs.'}
      </ConfirmDialog>
    </>
  )
}

/**
 * One job: status, timings, worker and why it ran (or what keeps it queued), the steps timeline
 * and log of the picked attempt, its agent runs with cost and transcripts, and its options.
 * The side sheet and the full page both render it.
 */
export function JobDetail({ job }: { job: Job }) {
  const { canGlobal } = useSession()
  const [picked, setPicked] = useState<number>()
  const why = useJobWhy(job.id, job.status)
  const attempt = picked !== undefined && picked <= job.attempts ? picked : job.attempts
  const entry = job.attemptsHistory.find((item) => item.n === attempt)
  const live = attempt === job.attempts && job.status === 'running'
  const log = useJobLog(job.id, attempt, live, LOG_TAIL)
  const now = new Date()
  const duration = jobDuration(job, now)
  const options = Object.keys(job.options).length ? job.options : undefined
  const actor = job.actor ? personOf(why.data?.people ?? {}, job.actor) : undefined
  const ran = entry ? attemptDuration(entry) : undefined

  return (
    <div className="flex flex-col gap-5">
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
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Fact label="Trigger">
          {job.schedule ? (
            <Link to="/jobs" search={{ schedule: job.schedule }} className="hover:underline">
              {job.schedule}
            </Link>
          ) : (
            jobTriggerLabel(job.trigger)
          )}
        </Fact>
        <Fact label="Requested by">
          {actor ? (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Avatar src={actor.avatarUrl} name={actor.name} size="xs" />
              <span className="truncate">{actor.name}</span>
            </span>
          ) : (
            <span className="text-dim">—</span>
          )}
        </Fact>
        <Fact label="Worker">
          {job.workerId ? (
            <span className="mono text-xs">{job.workerId}</span>
          ) : (
            <span className="text-dim">—</span>
          )}
        </Fact>
        <Fact label="Attempts">
          <span className="tabular">
            {job.attempts} of {job.maxAttempts}
          </span>
        </Fact>
        <Fact label="Created">
          <Time at={job.createdAt} now={now} />
        </Fact>
        <Fact label={job.status === 'queued' ? 'Runs after' : 'Started'}>
          <Time at={job.status === 'queued' ? job.runAfter : job.startedAt} now={now} />
        </Fact>
        <Fact label="Finished">
          <Time at={job.finishedAt} now={now} />
        </Fact>
        <Fact label="Duration">
          {duration === undefined ? (
            <span className="text-dim">—</span>
          ) : (
            <span className="mono">{formatDuration(duration)}</span>
          )}
        </Fact>
      </dl>

      <Section title="Why">
        {why.data ? (
          <div className="flex flex-col gap-1 text-[13px]">
            <p>
              {why.data.origin}.{' '}
              {(job.trigger !== 'manual' || job.schedule) && canGlobal('settings:read') ? (
                <Link
                  to="/automation"
                  search={{ job: job.id }}
                  className="text-xs text-muted hover:text-accent hover:underline"
                >
                  Show on Automation
                </Link>
              ) : null}
            </p>
            {why.data.wait ? (
              <ul className="flex flex-col gap-0.5 text-muted">
                {why.data.wait.reasons.length ? (
                  why.data.wait.reasons.map((reason, index) => (
                    <li key={index}>{waitReasonText(reason, now)}.</li>
                  ))
                ) : (
                  <li>Waits for a free worker slot.</li>
                )}
                <li className="tabular">
                  {why.data.wait.ahead} due job{why.data.wait.ahead === 1 ? '' : 's'} ahead in the
                  queue.
                </li>
              </ul>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted">{why.isError ? messageOf(why.error) : 'Loading…'}</p>
        )}
      </Section>

      {job.error ? (
        <div
          className={`flex flex-col gap-1.5 rounded-[7px] border px-3 py-2 ${job.status === 'blocked' ? 'border-warn/30 bg-warn/10' : 'border-bad/30 bg-bad/10'}`}
        >
          <p
            className={`text-xs font-medium ${job.status === 'blocked' ? 'text-warn' : 'text-bad'}`}
          >
            {job.status === 'blocked'
              ? 'Stopped by the AI budget; not retried'
              : job.status === 'failed'
                ? 'Failed'
                : 'Last attempt failed'}
          </p>
          <pre className="max-h-40 overflow-auto font-mono text-[11.5px] whitespace-pre-wrap">
            {job.error}
          </pre>
          {job.errorSignature ? (
            <Link
              to="/jobs"
              search={{ signature: job.errorSignature }}
              className="text-xs text-muted hover:underline"
            >
              Jobs with the same failure
            </Link>
          ) : null}
        </div>
      ) : null}

      <Section
        title="Attempt"
        aside={
          job.attemptsHistory.length > 1 ? (
            <Segmented
              aria-label="Attempt"
              size="sm"
              value={String(attempt)}
              onChange={(value) => setPicked(Number(value))}
              options={job.attemptsHistory.map((item) => ({
                id: String(item.n),
                label: attemptLabel(item),
              }))}
            />
          ) : null
        }
      >
        {entry ? (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <Tag tone={jobStatusTone(entry.status)}>{jobStatusLabel(entry.status)}</Tag>
            <span>
              started <Time at={entry.startedAt} now={now} />
            </span>
            {ran !== undefined ? <span className="mono">{formatDuration(ran)}</span> : null}
            {entry.workerId ? <span className="mono">{entry.workerId}</span> : null}
            {entry.step ? <span className="text-bad">failed in {entry.step}</span> : null}
          </p>
        ) : null}
        {entry ? (
          <StepsTimeline
            steps={log.data?.steps ?? []}
            start={entry.startedAt}
            end={entry.finishedAt ?? now.toISOString()}
          />
        ) : null}
      </Section>

      <Section title="Log" aside={live ? <Tag tone="info">live</Tag> : null}>
        <JobLogView key={attempt} jobId={job.id} attempt={attempt} live={live} />
      </Section>

      <JobAgentRuns jobId={job.id} live={isActiveJob(job)} />

      {options ? (
        <Section title="Options">
          <pre className="overflow-x-auto rounded-[7px] border border-line bg-sunk p-3 font-mono text-[11.5px]">
            {JSON.stringify(options, null, 2)}
          </pre>
        </Section>
      ) : null}
    </div>
  )
}
