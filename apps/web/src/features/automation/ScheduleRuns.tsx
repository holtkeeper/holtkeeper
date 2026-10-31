import type { ScheduleRun } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { Play } from 'lucide-react'

import { messageOf } from '../../api/client.ts'
import { useRunSchedule } from '../../api/queries.ts'
import { durationBetween, formatDateTime, formatRelative } from '../../lib/format.ts'
import {
  jobStatusLabel,
  jobStatusTone,
  scheduleRunShares,
  scheduleRunState,
} from '../../lib/jobs.ts'
import { Button, Chip, Tooltip, notify } from '../../ui/index.ts'

const statusColor = {
  default: 'var(--sev-unknown)',
  accent: 'var(--accent)',
  success: 'var(--success)',
  danger: 'var(--danger)',
} as const

/** Jobs of a run by status as one thin stacked bar; `vertical` stacks failures on top. */
function RunBar({ run, vertical = false }: { run: ScheduleRun; vertical?: boolean }) {
  return (
    <div
      className={`flex overflow-hidden rounded-full bg-default ${vertical ? 'h-6 w-2.5 flex-col-reverse' : 'h-1.5 w-28'}`}
      aria-hidden
    >
      {scheduleRunShares(run).map((share) => (
        <span
          key={share.status}
          style={{
            [vertical ? 'height' : 'width']: `${share.percent}%`,
            background: statusColor[jobStatusTone(share.status)],
          }}
          className={share.status === 'running' ? 'animate-pulse' : undefined}
        />
      ))}
    </div>
  )
}

function RunSummary({ run }: { run: ScheduleRun }) {
  return (
    <div className="flex min-w-48 flex-col gap-1.5 text-xs">
      <span className="font-medium">{formatDateTime(run.at)}</span>
      <span className="text-muted">
        {run.actor ? 'Started by hand' : 'Timed run'} · {run.analyzers.join(', ')}
      </span>
      <ul className="flex flex-col gap-0.5">
        {scheduleRunShares(run).map((share) => (
          <li key={share.status} className="flex justify-between gap-4">
            <span>{jobStatusLabel(share.status)}</span>
            <span className="tabular">{share.count}</span>
          </li>
        ))}
      </ul>
      {run.startedAt && run.finishedAt ? (
        <span className="text-muted">Took {durationBetween(run.startedAt, run.finishedAt)}</span>
      ) : null}
      {run.failures.length ? (
        <ul className="flex flex-col gap-0.5 border-t border-border pt-1.5">
          {run.failures.map((failure) => (
            <li key={failure.id} className="text-danger">
              <span className="font-mono">{failure.repo.path}</span> · {failure.analyzer}
              {failure.error ? (
                <span className="block truncate text-muted">{failure.error}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** The newest run of a schedule: its state, how its jobs are doing and a link to them. */
export function LastRun({ id, run }: { id: string; run: ScheduleRun | undefined }) {
  if (!run) return <span className="text-sm text-muted">Never ran</span>
  const state = scheduleRunState(run)
  const now = new Date()
  return (
    <Tooltip content={<RunSummary run={run} />} delay={150}>
      <div tabIndex={0} className="flex flex-col gap-1.5 whitespace-nowrap">
        <span className="flex items-center gap-2">
          <Chip tone={state.tone}>{state.label}</Chip>
          <span className="text-xs text-muted">{formatRelative(run.at, now)}</span>
        </span>
        <RunBar run={run} />
        <Link
          to="/jobs"
          search={{ schedule: id }}
          className="text-xs text-muted hover:text-accent hover:underline"
        >
          {run.jobs} {run.jobs === 1 ? 'job' : 'jobs'}
          {run.startedAt && run.finishedAt
            ? ` · ${durationBetween(run.startedAt, run.finishedAt)}`
            : ''}
        </Link>
      </div>
    </Tooltip>
  )
}

/** Up to ten earlier runs, oldest left, as small bars colored by their outcome. */
export function RunHistory({ runs }: { runs: readonly ScheduleRun[] }) {
  if (runs.length < 2) return <span className="text-sm text-muted">—</span>
  return (
    <div className="flex items-end gap-1" aria-label={`${runs.length} recent runs`}>
      {runs.toReversed().map((run) => (
        <Tooltip key={run.at} content={<RunSummary run={run} />} delay={100}>
          <span tabIndex={0} className="inline-flex">
            <RunBar run={run} vertical />
          </span>
        </Tooltip>
      ))}
    </div>
  )
}

/** Queues every job of the schedule now, even when it is switched off. */
export function RunNowButton({ id, name }: { id: string; name: string }) {
  const run = useRunSchedule()
  return (
    <Button
      variant="ghost"
      size="sm"
      isIconOnly
      aria-label={`Run ${name} now`}
      isPending={run.isPending}
      onPress={() =>
        run.mutate(id, {
          onSuccess: () => notify.success(`${name} started`, 'Jobs appear here as they are queued'),
          onError: (error) => notify.error('Not started', messageOf(error)),
        })
      }
    >
      <Play className="size-3.5" />
    </Button>
  )
}
