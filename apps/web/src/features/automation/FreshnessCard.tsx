import type { FreshnessOverview, JobAnalyzerView, SettingView } from '@holtkeeper/api'

import { messageOf } from '../../api/client.ts'
import { useSettingMutations } from '../../api/queries.ts'
import {
  FRESHNESS_KEY,
  describeRefresh,
  laneFreshness,
  sweepLimits,
} from '../../lib/automation-flow.ts'
import { formatRelative } from '../../lib/format.ts'
import { Button, Segmented, Select, Tag, notify } from '../../ui/index.ts'

const modes = [
  { id: 'on', label: 'On' },
  { id: 'slower', label: 'Slower' },
  { id: 'off', label: 'Off' },
] as const

const factors = [2, 3, 5, 10].map((factor) => ({ id: String(factor), label: `${factor}x` }))

/**
 * A team's freshness: per analyzer its refresh policy and what the last sweep found stale, the
 * next sweep and night window, and the team's override (on, slower, off), the only thing it edits.
 */
export function FreshnessCard({
  group,
  analyzers,
  overview,
  settings,
  writable,
}: {
  /** Absent for every repository. */
  group?: string
  analyzers: readonly JobAnalyzerView[]
  overview: FreshnessOverview | undefined
  settings: readonly SettingView[]
  writable: boolean
}) {
  const { put, remove } = useSettingMutations()
  const override = laneFreshness(settings, group)
  const limits = sweepLimits(settings)
  const counts = new Map(
    (overview?.teams.find((team) => team.group === group)?.analyzers ?? []).map((row) => [
      row.analyzer,
      row,
    ]),
  )
  const rows = analyzers.filter(
    (analyzer) =>
      analyzer.refresh !== undefined && (group !== undefined || analyzer.scope === 'repo'),
  )
  const scope = group === undefined ? { all: true } : { groups: [group] }
  const own = override.inherited ? undefined : override.entry
  const save = (value: { mode: string; factor?: number }) =>
    put.mutate(
      { ...(own ? { id: own.id } : {}), key: FRESHNESS_KEY, scope, value },
      {
        onSuccess: () => notify.success('Freshness saved', group ?? 'All repositories'),
        onError: (error) => notify.error('Not saved', messageOf(error)),
      },
    )
  const stale = rows.reduce((sum, a) => sum + (counts.get(a.kind)?.stale ?? 0), 0)

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-3">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-[13px] font-semibold">Freshness</h3>
        {stale ? <Tag tone="warning">{stale} stale</Tag> : <Tag tone="success">current</Tag>}
        <span className="ml-auto">
          {writable ? (
            <Segmented
              aria-label={`Freshness of ${group ?? 'every repository'}`}
              options={modes}
              value={override.mode}
              onChange={(mode) =>
                save(mode === 'slower' ? { mode, factor: override.factor } : { mode })
              }
            />
          ) : (
            <Tag>{override.mode}</Tag>
          )}
        </span>
      </header>
      {override.mode === 'slower' && writable ? (
        <Select
          label="Every interval and cadence times"
          options={factors}
          value={String(override.factor)}
          onChange={(factor) => save({ mode: 'slower', factor: Number(factor) })}
        />
      ) : null}
      {override.inherited && override.entry ? (
        <p className="text-xs text-muted">
          {override.entry.scope.all
            ? 'Inherited from every repository.'
            : 'Inherited from a setting shared with other groups.'}
        </p>
      ) : own && group !== undefined && writable ? (
        <Button
          variant="ghost"
          size="sm"
          isPending={remove.isPending}
          onPress={() => remove.mutate(own.id)}
        >
          Use the every-repository setting
        </Button>
      ) : null}
      <ul className="flex flex-col divide-y divide-line text-[12.5px]">
        {rows.map((analyzer) => {
          const row = counts.get(analyzer.kind)
          return (
            <li key={analyzer.kind} className="flex items-center gap-2 py-1.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{analyzer.label}</span>
                <span className="block truncate text-[11px] text-muted">
                  {describeRefresh(analyzer.refresh!)}
                  {analyzer.needs.agent ? ' · AI, budget permitting' : ''}
                </span>
              </span>
              {row?.stale ? <Tag tone="warning">{row.stale} stale</Tag> : null}
              {row?.waiting ? <Tag tone="info">{row.waiting} waiting</Tag> : null}
              {row && !row.stale && !row.waiting ? (
                <span className="text-[11px] text-dim">{row.fresh} fresh</span>
              ) : null}
            </li>
          )
        })}
      </ul>
      <footer className="flex flex-col gap-0.5 border-t border-line pt-2 text-[11px] text-muted">
        <span>
          {overview?.nextAt
            ? `Next sweep ${formatRelative(overview.nextAt)}, every ${overview.sweepMinutes} min`
            : 'No sweep yet: it starts a minute after the leader takes over'}
        </span>
        <span>
          Heavy analyzers run{' '}
          <span className="mono">
            {limits.nightWindow.from}–{limits.nightWindow.to}
          </span>
          ; at most {limits.maxJobsPerHour} jobs and {limits.maxAiJobsPerHour} AI jobs an hour.
        </span>
      </footer>
    </section>
  )
}
