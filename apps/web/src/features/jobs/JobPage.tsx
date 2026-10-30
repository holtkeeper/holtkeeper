import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { ArrowLeft, FileText, RotateCw, Square } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useJob, useJobAnalyzers, useJobMutations } from '../../api/queries.ts'
import { formatDateTime, formatDuration, formatRelative } from '../../lib/format.ts'
import {
  analyzerLabel,
  canCancelJob,
  isActiveJob,
  jobDuration,
  jobStatusLabel,
  jobStatusTone,
  jobTriggerLabel,
  rerunJobInput,
} from '../../lib/jobs.ts'
import { repoKey } from '../../lib/repo.ts'
import {
  Button,
  Chip,
  ConfirmDialog,
  ErrorState,
  LinkButton,
  Notice,
  Page,
  Panel,
  Placeholder,
  notify,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  )
}

function Time({ at, now }: { at: string | undefined; now: Date }) {
  if (!at) return <span className="text-muted">—</span>
  return (
    <time dateTime={at} title={formatDateTime(at)}>
      {formatRelative(at, now)}
    </time>
  )
}

/**
 * One job: its facts, options, error, live log, a way to cancel it while it runs and to queue it
 * again once it finished.
 */
export function JobPage() {
  const { jobId } = useParams({ from: '/app/jobs/$jobId' })
  const job = useJob(jobId)
  const analyzers = useJobAnalyzers()
  const { can } = useSession()
  const { cancel, create } = useJobMutations()
  const navigate = useNavigate()
  const [confirm, setConfirm] = useState(false)

  if (job.isPending) return <Placeholder className="h-96" />
  if (job.isError) return <ErrorState error={job.error} />

  const data = job.data
  const now = new Date()
  const label = analyzerLabel(analyzers.data?.analyzers ?? [], data.analyzer)
  const duration = jobDuration(data, now)
  const options = Object.keys(data.options).length ? data.options : undefined

  return (
    <Page
      eyebrow={
        <Link to="/jobs" search={{}} className="inline-flex items-center gap-1 hover:underline">
          <ArrowLeft className="size-3.5" />
          Jobs
        </Link>
      }
      title={
        <span className="flex items-center gap-3">
          {label}
          <Chip tone={jobStatusTone(data.status)} size="md">
            {jobStatusLabel(data.status)}
          </Chip>
        </span>
      }
      description={
        data.group !== undefined ? (
          <Link
            to="/repos/groups/$groupId"
            params={{ groupId: data.group }}
            search={{}}
            className="hover:underline"
          >
            Group {data.group}
          </Link>
        ) : (
          <Link
            to="/repos/view"
            search={{ repo: repoKey(data.repo) }}
            className="font-mono hover:underline"
          >
            {data.repo.path}
          </Link>
        )
      }
      actions={
        <>
          {data.analysisId ? (
            <LinkButton to="/analyses/$id" params={{ id: data.analysisId }} search={{}}>
              <FileText className="size-4" />
              Open result
            </LinkButton>
          ) : null}
          {!isActiveJob(data) && can('analyses:run') ? (
            <Button
              variant="secondary"
              isPending={create.isPending}
              onPress={() =>
                create.mutate(rerunJobInput(data), {
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
          {canCancelJob(data) && can('analyses:run') ? (
            <Button variant="danger-soft" onPress={() => setConfirm(true)}>
              <Square className="size-3.5" />
              Cancel job
            </Button>
          ) : null}
        </>
      }
    >
      <Panel title="Details">
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Fact label="Trigger">{jobTriggerLabel(data.trigger)}</Fact>
          <Fact label="Requested by">
            {data.actor ? (
              <span className="font-mono text-xs">{data.actor}</span>
            ) : (
              <span className="text-muted">—</span>
            )}
          </Fact>
          <Fact label="Ref">
            {data.ref ? (
              <span className="font-mono text-xs">{data.ref}</span>
            ) : (
              <span className="text-muted">Default branch</span>
            )}
          </Fact>
          <Fact label="Attempts">
            {data.attempts} of {data.maxAttempts}
          </Fact>
          <Fact label="Created">
            <Time at={data.createdAt} now={now} />
          </Fact>
          <Fact label={data.status === 'queued' ? 'Runs after' : 'Started'}>
            <Time at={data.status === 'queued' ? data.runAfter : data.startedAt} now={now} />
          </Fact>
          <Fact label="Finished">
            <Time at={data.finishedAt} now={now} />
          </Fact>
          <Fact label="Duration">
            {duration === undefined ? (
              <span className="text-muted">—</span>
            ) : (
              formatDuration(duration)
            )}
          </Fact>
        </dl>
      </Panel>

      {data.error ? (
        <Notice tone="danger" title={data.status === 'failed' ? 'Failed' : 'Last attempt failed'}>
          <span className="whitespace-pre-wrap font-mono text-xs">{data.error}</span>
        </Notice>
      ) : null}

      <Panel title="Log" description={isActiveJob(data) ? 'Updates while the job runs' : undefined}>
        <LogView lines={data.log} />
      </Panel>

      {options ? (
        <Panel title="Options">
          <pre className="overflow-x-auto rounded-xl bg-default/60 p-3 font-mono text-xs">
            {JSON.stringify(options, null, 2)}
          </pre>
        </Panel>
      ) : null}

      <ConfirmDialog
        isOpen={confirm}
        onOpenChange={setConfirm}
        title="Cancel this job?"
        confirmLabel="Cancel job"
        isPending={cancel.isPending}
        onConfirm={() =>
          cancel.mutate(data.id, {
            onSuccess: () => {
              setConfirm(false)
              notify.success('Job canceled', label)
            },
            onError: (error) => notify.error('Job not canceled', messageOf(error)),
          })
        }
      >
        {data.status === 'running'
          ? 'The running analyzer is stopped and its partial work is discarded.'
          : 'The job leaves the queue and never runs.'}
      </ConfirmDialog>
    </Page>
  )
}

function LogView({ lines }: { lines: readonly string[] }) {
  const box = useRef<HTMLPreElement>(null)
  const follow = useRef(true)

  useEffect(() => {
    const element = box.current
    if (element && follow.current) element.scrollTop = element.scrollHeight
  }, [lines.length])

  if (!lines.length) return <p className="text-sm text-muted">No log lines yet.</p>
  return (
    <pre
      ref={box}
      onScroll={(event) => {
        const element = event.currentTarget
        follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
      }}
      className="max-h-[32rem] overflow-auto rounded-xl bg-default/60 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words"
    >
      {lines.join('\n')}
    </pre>
  )
}
