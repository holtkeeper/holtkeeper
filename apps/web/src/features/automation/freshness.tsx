import type { FreshnessOverview, JobAnalyzerView, SettingView } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { messageOf } from '../../api/client.ts'
import { useSettingMutations } from '../../api/queries.ts'
import {
  ALL_LANE,
  FRESHNESS_KEY,
  describeRefresh,
  laneFreshness,
  sweepLimits,
} from '../../lib/automation-flow.ts'
import { formatRelative } from '../../lib/format.ts'
import { Button, Segmented, Select, Table, Tag, Td, Th, notify } from '../../ui/index.ts'

const modes = [
  { id: 'on', label: 'On' },
  { id: 'slower', label: 'Slower' },
  { id: 'off', label: 'Off' },
] as const

const factors = [2, 3, 5, 10].map((factor) => ({
  id: String(factor),
  label: `${factor}× interval and cadence`,
}))

type Counts = { stale: number; waiting: number; fresh: number }

const teamCounts = (overview: FreshnessOverview | undefined, group: string | undefined): Counts =>
  (overview?.teams.find((team) => team.group === group)?.analyzers ?? []).reduce(
    (sum, row) => ({
      stale: sum.stale + row.stale,
      waiting: sum.waiting + row.waiting,
      fresh: sum.fresh + row.fresh,
    }),
    { stale: 0, waiting: 0, fresh: 0 },
  )

/** Lane ids → the group a freshness row edits; `all` is every repository. */
const groupOf = (lane: string) => (lane === ALL_LANE ? undefined : lane)

/** A team's freshness override (on, slower, off) with the slowdown factor, saved on change. */
function ModeControl({
  group,
  settings,
  writable,
}: {
  group: string | undefined
  settings: readonly SettingView[]
  writable: boolean
}) {
  const { put } = useSettingMutations()
  const override = laneFreshness(settings, group)
  const own = override.inherited ? undefined : override.entry
  const name = group ?? 'all repositories'
  if (!writable) return <Tag>{override.mode}</Tag>
  const save = (value: { mode: string; factor?: number }) =>
    put.mutate(
      {
        ...(own ? { id: own.id } : {}),
        key: FRESHNESS_KEY,
        scope: group === undefined ? { all: true } : { groups: [group] },
        value,
      },
      {
        onSuccess: () => notify.success('Freshness saved', group ?? 'All repositories'),
        onError: (error) => notify.error('Not saved', messageOf(error)),
      },
    )
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented
        aria-label={`Freshness for ${name}`}
        size="sm"
        options={modes}
        value={override.mode}
        onChange={(mode) => save(mode === 'slower' ? { mode, factor: override.factor } : { mode })}
      />
      {override.mode === 'slower' ? (
        <Select
          aria-label={`Slowdown for ${name}`}
          options={factors}
          value={String(override.factor)}
          onChange={(factor) => save({ mode: 'slower', factor: Number(factor) })}
          className="w-52"
        />
      ) : null}
    </div>
  )
}

/** Where a team's freshness comes from, with a way back to the every-repository setting. */
function SettingSource({
  group,
  settings,
  writable,
}: {
  group: string | undefined
  settings: readonly SettingView[]
  writable: boolean
}) {
  const { remove } = useSettingMutations()
  const override = laneFreshness(settings, group)
  if (group === undefined) return <span className="text-muted">Every-repository setting</span>
  if (override.inherited)
    return (
      <span className="text-muted">
        {override.entry && !override.entry.scope.all
          ? 'Inherited from a setting shared with other groups'
          : 'Inherited from every repository'}
      </span>
    )
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-muted">Own setting</span>
      {writable && override.entry ? (
        <Button
          variant="ghost"
          size="sm"
          isPending={remove.isPending}
          onPress={() => override.entry && remove.mutate(override.entry.id)}
        >
          Use the every-repository setting
        </Button>
      ) : null}
    </span>
  )
}

/** One freshness row per team (lane): its override, where it comes from, and the last sweep's counts. */
export function FreshnessTeams({
  lanes,
  settings,
  overview,
  writable,
}: {
  lanes: readonly { id: string; label: string }[]
  settings: readonly SettingView[]
  overview: FreshnessOverview | undefined
  writable: boolean
}) {
  return (
    <Table label="Freshness by team">
      <thead>
        <tr>
          <Th>Team</Th>
          <Th>Sweeping</Th>
          <Th>Setting</Th>
          <Th align="right">Stale</Th>
          <Th align="right">Waiting</Th>
          <Th align="right">Fresh</Th>
        </tr>
      </thead>
      <tbody>
        {lanes.map((lane) => {
          const group = groupOf(lane.id)
          const counts = teamCounts(overview, group)
          return (
            <tr key={lane.id}>
              <Td>{lane.label}</Td>
              <Td>
                <ModeControl group={group} settings={settings} writable={writable} />
              </Td>
              <Td>
                <SettingSource group={group} settings={settings} writable={writable} />
              </Td>
              <Td align="right" className="mono">
                {counts.stale}
              </Td>
              <Td align="right" className="mono">
                {counts.waiting}
              </Td>
              <Td align="right" className="mono text-muted">
                {counts.fresh}
              </Td>
            </tr>
          )
        })}
      </tbody>
    </Table>
  )
}

/** Per analyzer that refreshes: its policy and what the last sweep found for one team. */
export function FreshnessAnalyzers({
  group,
  analyzers,
  overview,
}: {
  group: string | undefined
  analyzers: readonly JobAnalyzerView[]
  overview: FreshnessOverview | undefined
}) {
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
  return (
    <Table label={`Analyzers kept fresh for ${group ?? 'every repository'}`}>
      <thead>
        <tr>
          <Th>Analyzer</Th>
          <Th>Refreshes</Th>
          <Th align="right">Stale</Th>
          <Th align="right">Waiting</Th>
          <Th align="right">Fresh</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((analyzer) => {
          const row = counts.get(analyzer.kind)
          return (
            <tr key={analyzer.kind}>
              <Td>
                <span className="flex items-center gap-1.5">
                  <span className="font-medium">{analyzer.label}</span>
                  {analyzer.needs.agent ? <Tag tone="code">AI</Tag> : null}
                </span>
              </Td>
              <Td className="text-muted">{describeRefresh(analyzer.refresh!)}</Td>
              <Td align="right" className="mono">
                {row?.stale ?? 0}
              </Td>
              <Td align="right" className="mono">
                {row?.waiting ?? 0}
              </Td>
              <Td align="right" className="mono text-muted">
                {row?.fresh ?? 0}
              </Td>
            </tr>
          )
        })}
      </tbody>
    </Table>
  )
}

function Tile({ label, value, caption }: { label: string; value: ReactNode; caption?: ReactNode }) {
  return (
    <div className="flex min-w-36 flex-1 flex-col gap-0.5 rounded-xl border border-line bg-panel px-3.5 py-2.5">
      <span className="text-xs text-muted">{label}</span>
      <span className="mono text-lg font-semibold">{value}</span>
      {caption ? <span className="text-[11px] text-dim">{caption}</span> : null}
    </div>
  )
}

/** Stale, waiting and fresh totals over `lanes`, and when the next sweep runs. */
export function FreshnessTiles({
  lanes,
  overview,
}: {
  lanes: readonly { id: string }[]
  overview: FreshnessOverview | undefined
}) {
  const total = lanes
    .map((lane) => teamCounts(overview, groupOf(lane.id)))
    .reduce(
      (sum, counts) => ({
        stale: sum.stale + counts.stale,
        waiting: sum.waiting + counts.waiting,
        fresh: sum.fresh + counts.fresh,
      }),
      { stale: 0, waiting: 0, fresh: 0 },
    )
  return (
    <div className="flex flex-wrap gap-2">
      <Tile label="Stale" value={total.stale} caption="results older than their repository" />
      <Tile label="Waiting" value={total.waiting} caption="queued by the last sweeps" />
      <Tile label="Fresh" value={total.fresh} />
      <Tile
        label="Next sweep"
        value={overview?.nextAt ? formatRelative(overview.nextAt) : '—'}
        caption={
          overview?.nextAt
            ? `every ${overview.sweepMinutes} min`
            : 'starts a minute after the leader takes over'
        }
      />
    </div>
  )
}

/** Stale results in total over `lanes`, for the tab count. */
export const staleCount = (
  lanes: readonly { id: string }[],
  overview: FreshnessOverview | undefined,
): number => lanes.reduce((sum, lane) => sum + teamCounts(overview, groupOf(lane.id)).stale, 0)

/** The sweeper's night window and hourly caps, with a link to change them. */
export function SweepLimitsNote({ settings }: { settings: readonly SettingView[] }) {
  const limits = sweepLimits(settings)
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      <span>
        Heavy analyzers run{' '}
        <span className="mono">
          {limits.nightWindow.from}–{limits.nightWindow.to}
        </span>{' '}
        · at most {limits.maxJobsPerHour} jobs and {limits.maxAiJobsPerHour} AI jobs an hour
      </span>
      <Link
        to="/settings/$section"
        params={{ section: 'system' }}
        className="hover:text-foreground hover:underline"
      >
        Change sweep limits
      </Link>
    </span>
  )
}
