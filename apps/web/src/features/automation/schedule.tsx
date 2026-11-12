import type { ConfigEntryView } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { Pause, Play } from 'lucide-react'
import type { ReactNode } from 'react'

import { messageOf } from '../../api/client.ts'
import { useConfigMutations, useGroupTitles, useRunSchedule } from '../../api/queries.ts'
import {
  cronFields,
  describeCadence,
  describeWindows,
  runCounts,
  runOutcome,
  runOutcomes,
  runTicks,
  toScheduleDraft,
  toScheduleInput,
} from '../../lib/automation.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import { groupMatchTitle } from '../../lib/group-titles.ts'
import { jobStatusLabel, jobStatusTone, scheduleRunShares } from '../../lib/jobs.ts'
import {
  KeyValue,
  Legend,
  LinkButton,
  Notice,
  Tag,
  TickStrip,
  notify,
  quietActionsOf,
} from '../../ui/index.ts'
import { HISTORY_RUNS, type ScheduleRow } from './model.ts'

/** Pauses or resumes a schedule, keeping the rest of it as stored. */
export function useToggleSchedule() {
  const { put } = useConfigMutations('schedules')
  return (entry: ConfigEntryView<'schedule'>, enabled: boolean) =>
    put.mutate(
      { id: entry.id, data: toScheduleInput({ ...toScheduleDraft(entry), enabled }) },
      {
        onSuccess: () => notify.success(enabled ? 'Schedule resumed' : 'Schedule paused', entry.id),
        onError: (error) => notify.error('Not saved', messageOf(error)),
      },
    )
}

/** Queues a schedule's jobs now. */
export function useRunNow() {
  const run = useRunSchedule()
  return (id: string, name: string) =>
    run.mutate(id, {
      onSuccess: () => notify.success(`${name} started`, 'Its jobs show up in Ops › Runs'),
      onError: (error) => notify.error('Not started', messageOf(error)),
    })
}

/** "Run now" and "Pause"/"Resume" for the sheet's quiet actions, as the reader may use them. */
export function useScheduleActions(
  row: ScheduleRow | undefined,
  allowed: { canRun: boolean; writable: boolean },
) {
  const runNow = useRunNow()
  const toggle = useToggleSchedule()
  if (!row) return undefined
  const enabled = row.entry.data.enabled
  const actions = [
    ...(allowed.canRun
      ? [{ label: 'Run now', icon: Play, onPress: () => runNow(row.id, row.name) }]
      : []),
    ...(allowed.writable
      ? [
          {
            label: enabled ? 'Pause' : 'Resume',
            icon: enabled ? Pause : Play,
            onPress: () => toggle(row.entry, !enabled),
          },
        ]
      : []),
  ]
  return quietActionsOf(actions)
}

/** The newest run as a status bar for the sheet's header. */
export function scheduleProgress(row: ScheduleRow) {
  const last = row.runs[0]
  if (!last) return undefined
  return {
    segments: scheduleRunShares(last).map((share) => ({
      value: share.count,
      tone: jobStatusTone(share.status),
      label: jobStatusLabel(share.status),
    })),
    label: `Last run: ${runOutcomes[runOutcome(last)].label} · ${last.jobs} ${last.jobs === 1 ? 'job' : 'jobs'} · ${formatRelative(last.at)}`,
  }
}

/** The ticks of the newest runs, oldest first, each labelled with its time and outcome. */
export function RunTicks({
  row,
  count,
  className,
}: {
  row: ScheduleRow
  count: number
  className?: string
}) {
  const ticks = runTicks(row.runs, count).map((tick) => ({
    tone: runOutcomes[tick.outcome].tone,
    label: `${formatDateTime(tick.at)} · ${runOutcomes[tick.outcome].label}`,
  }))
  if (!ticks.length) return <span className="text-xs text-dim">No runs yet</span>
  return (
    <TickStrip
      ticks={ticks}
      {...(className ? { className } : {})}
      aria-label={`Last ${ticks.length} runs of ${row.name}: ${runCounts(row.runs.slice(0, count))}`}
    />
  )
}

/** Run outcomes and their colors, for the list and the sheet. */
export const runLegend = (['succeeded', 'partial', 'failed', 'blocked', 'skipped'] as const).map(
  (outcome) => {
    const tone = runOutcomes[outcome].tone
    return tone === 'skipped'
      ? { label: 'Skipped', color: 'var(--line-strong)' }
      : { label: runOutcomes[outcome].label, tone }
  },
)

function FailureCallout({ row }: { row: ScheduleRow }) {
  const { health } = row
  const last = health.last
  if (!last || (health.state !== 'failing' && health.state !== 'partial')) return null
  const first = last.failures[0]
  const repos = [...new Set(last.failures.map((failure) => failure.repo.path))]
  return (
    <Notice
      tone="danger"
      title={
        health.failedInRow > 1
          ? `Failed ${health.failedInRow} runs in a row`
          : `${last.failed} of ${last.jobs} jobs failed`
      }
    >
      <span className="flex flex-col gap-1.5">
        {first?.error ? <span className="mono break-words text-xs">{first.error}</span> : null}
        {repos.length ? (
          <span className="text-xs text-muted">
            On{' '}
            {repos.map((repo, index) => (
              <span key={repo}>
                {index ? ', ' : ''}
                <span className="mono">{repo}</span>
              </span>
            ))}
          </span>
        ) : null}
        <span className="flex flex-wrap items-center gap-2">
          {first ? (
            <LinkButton to="/ops/runs/$jobId" params={{ jobId: first.id }} size="sm">
              View log
            </LinkButton>
          ) : null}
          <Link
            to="/ops/runs"
            search={{ schedule: row.id }}
            className="text-xs text-muted hover:text-foreground hover:underline"
          >
            All jobs of this schedule
          </Link>
        </span>
      </span>
    </Notice>
  )
}

function Section({
  title,
  aside,
  children,
}: {
  title: string
  aside?: string
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-2 border-t border-line pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
        {aside ? <span className="ml-auto text-xs text-muted">{aside}</span> : null}
      </div>
      {children}
    </section>
  )
}

const tagList = (items: readonly string[], mono = false) =>
  items.length ? (
    <span className="flex flex-wrap gap-1">
      {items.map((item) => (
        <Tag key={item} mono={mono}>
          {item}
        </Tag>
      ))}
    </span>
  ) : null

/**
 * A schedule at a glance: the failure of its newest run, its last 30 runs as ticks, the cron
 * breakdown, the next five run times and the rule in When / Where / If / Then / Limits terms.
 */
export function ScheduleOverview({ row }: { row: ScheduleRow }) {
  const titleOf = useGroupTitles()
  const data = row.entry.data
  const fields = data.cron ? cronFields(data.cron) : undefined
  const windows = describeWindows(data.windows)
  const now = new Date()
  const shown = row.runs.slice(0, HISTORY_RUNS)
  return (
    <div className="flex flex-col gap-4">
      <FailureCallout row={row} />
      <Section title="Run history" {...(shown.length ? { aside: runCounts(shown) } : {})}>
        <RunTicks row={row} count={HISTORY_RUNS} />
        {shown.length ? (
          <span className="mono flex justify-between text-[11px] text-dim">
            <span>{formatDateTime(shown.at(-1)!.at)}</span>
            <span>{formatRelative(shown[0]!.at, now)}</span>
          </span>
        ) : null}
        <Legend items={runLegend} label="Run outcomes" />
      </Section>
      {fields ? (
        <Section title="Cron">
          <div
            className="grid gap-1.5"
            style={{ gridTemplateColumns: `repeat(${fields.length}, minmax(0, 1fr))` }}
          >
            {fields.map((field) => (
              <div
                key={field.label}
                className="flex flex-col items-center gap-0.5 rounded-lg border border-line bg-raise px-2 py-1.5"
              >
                <span className="text-[11px] text-muted">{field.label}</span>
                <b className="mono text-[13px]">{field.value}</b>
              </div>
            ))}
          </div>
        </Section>
      ) : null}
      <Section title={`Next ${Math.min(row.next.length, 5) || 5} runs`}>
        {row.next.length ? (
          <ol className="m-0 flex list-none flex-col p-0 text-[12.5px]">
            {row.next.slice(0, 5).map((at, index) => (
              <li
                key={at}
                className="flex items-center gap-2 border-b border-line py-1.5 last:border-b-0"
              >
                <span className="mono w-4 text-dim">{index + 1}</span>
                <span>{formatDateTime(at)}</span>
                <span className="ml-auto text-muted">{formatRelative(at, now)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <span className="text-xs text-muted">
            {data.enabled ? 'Nothing due soon.' : 'Paused: no runs are due.'}
          </span>
        )}
      </Section>
      <Section title="Rule">
        <KeyValue
          rows={[
            {
              label: 'Cadence',
              value: (
                <>
                  <span className="mono">{data.cron ?? data.every}</span>
                  <span className="text-muted">
                    {describeCadence(data)} · {data.timezone ?? "the instance's time zone"}
                  </span>
                </>
              ),
            },
            {
              label: 'Jitter',
              value: data.jitterMinutes ? `${data.jitterMinutes} min` : null,
            },
            {
              label: 'Groups',
              value: data.groups?.length
                ? tagList(data.groups.map((entry) => groupMatchTitle(entry, titleOf)))
                : 'Every repository',
            },
            { label: 'Repositories', value: tagList(data.repos ?? [], true) },
            { label: 'Only when', value: windows.length ? windows.join(', ') : 'Always' },
            { label: 'Analyzers', value: tagList(data.analyzers, true) },
            {
              label: 'Spread',
              value: data.spread ? 'Repository jobs spread over the allowed window' : null,
            },
          ]}
        />
      </Section>
    </div>
  )
}
