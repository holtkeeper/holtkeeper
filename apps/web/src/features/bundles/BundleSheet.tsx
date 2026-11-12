import type { BundleSeries } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { History, Package, Play } from 'lucide-react'
import { useState } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { useBundleReport, useBundleTargets } from '../../api/queries.ts'
import {
  type BundleRow,
  type BundleTab,
  type ChartRow,
  type Compression,
  budgetShare,
  budgetState,
  budgetStateLabel,
  budgetStateTone,
  bundleTabs,
  chartEntrypoints,
  chartRows,
  historyRows,
  overallChange,
  pointLabel,
  pointSearch,
  rowRelease,
  sheetSections,
} from '../../lib/bundles.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import { repoSplat } from '../../lib/repo.ts'
import { formatValue } from '../../lib/units.ts'
import {
  EmptyState,
  ErrorState,
  KeyValue,
  Placeholder,
  Segmented,
  SideSheet,
  Table,
  Tag,
  Td,
  Th,
} from '../../ui/index.ts'
import { useBackfillReleases } from '../analyses/BackfillReleases.tsx'
import { useRunJob } from '../jobs/RunJobDialog.tsx'
import { BlockView } from '../reports/BlockView.tsx'
import { Delta } from './Delta.tsx'

const tabLabels: Record<BundleTab, string> = {
  composition: 'Composition',
  entrypoints: 'Entrypoints',
  packages: 'Packages',
  history: 'History',
}

const compressions = [
  { id: 'gzip', label: 'Gzip' },
  { id: 'brotli', label: 'Brotli' },
  { id: 'raw', label: 'Raw' },
] as const

const bytes = (value: number | null | undefined) => formatValue(value, 'bytes')

/** A point of a target's history picked by its `version` or record id. */
export interface BundlePointPick {
  version?: string
  analysis?: string
}

function HistoryChart({
  series,
  compression,
  selectedKey,
  onSelect,
}: {
  series: BundleSeries
  compression: Compression
  selectedKey: string | undefined
  onSelect: (index: number) => void
}) {
  const entrypoints = chartEntrypoints(series, compression)
  const rows = chartRows(series, compression, entrypoints)
  const lines: { key: 'total' | `entry:${string}`; label: string }[] = [
    { key: 'total', label: 'Total' },
    ...entrypoints.map((name) => ({ key: `entry:${name}` as const, label: `${name} (initial)` })),
  ]
  const selected = rows.find((row) => row.key === selectedKey)
  return (
    <div className="flex flex-col gap-2">
      <div
        className="h-48 w-full"
        role="img"
        aria-label={`${series.name} over ${rows.length} measurements`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={rows}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            onClick={(state) => {
              const index = Number(state.activeTooltipIndex)
              if (Number.isInteger(index)) onSelect(index)
            }}
          >
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              minTickGap={24}
              tick={{ fill: 'var(--chart-axis)', fontSize: 11 }}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={64}
              tickFormatter={(value: number) => bytes(value)}
              tick={{ fill: 'var(--chart-axis)', fontSize: 11 }}
            />
            <Tooltip
              cursor={{ stroke: 'var(--line-strong)', strokeWidth: 1 }}
              content={({ active, label }) => {
                const row: ChartRow | undefined = rows.find((item) => item.label === label)
                if (!active || !row) return null
                return (
                  <div className="min-w-44 rounded-lg border border-line bg-raise p-2.5 text-xs">
                    <div className="mb-1.5 font-medium">
                      <span className="mono">{row.label}</span>
                      {row.at ? (
                        <span className="ml-2 text-muted">{row.at.slice(0, 10)}</span>
                      ) : null}
                    </div>
                    {row.status === 'failed' ? (
                      <div className="text-bad">Not measured</div>
                    ) : (
                      lines.map((line, index) => (
                        <div key={line.key} className="flex justify-between gap-4 py-0.5">
                          <span className="flex items-center gap-1.5 text-muted">
                            <span
                              className="size-2 rounded-full"
                              style={{ background: `var(--series-${index + 1})` }}
                            />
                            {line.label}
                          </span>
                          <span className="tabular mono">{bytes(row[line.key])}</span>
                        </div>
                      ))
                    )}
                  </div>
                )
              }}
            />
            {lines.map((line, index) => (
              <Line
                key={line.key}
                type="monotone"
                dataKey={line.key}
                name={line.label}
                stroke={`var(--series-${index + 1})`}
                strokeWidth={line.key === 'total' ? 2 : 1.25}
                dot={{ r: rows.length > 30 ? 0 : 2.5 }}
                activeDot={{ r: 4, cursor: 'pointer' }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted" aria-label="Legend">
        {lines.map((line, index) => (
          <li key={line.key} className="flex items-center gap-1.5">
            <span
              className="size-2 rounded-full"
              style={{ background: `var(--series-${index + 1})` }}
            />
            {line.label}
          </li>
        ))}
        {selected ? (
          <li className="ms-auto">
            Picked <span className="mono">{selected.label}</span>
          </li>
        ) : null}
      </ul>
    </div>
  )
}

function HistoryTab({
  row,
  selectedKey,
  onPick,
}: {
  row: BundleRow
  selectedKey: string | undefined
  onPick: (pick: BundlePointPick) => void
}) {
  const [compression, setCompression] = useState<Compression>('gzip')
  const targets = useBundleTargets(row.repo)
  if (targets.isPending) return <Placeholder className="h-64" />
  if (targets.isError) return <ErrorState error={targets.error} />
  const series = targets.data.series.find((entry) => entry.name === row.name)
  if (!series?.points.length)
    return <EmptyState icon={<Package />} title="No history for this target yet" />
  const change = overallChange(series, compression)
  const failed = series.points.filter((point) => point.status === 'failed').length
  const pick = (index: number) => {
    const point = series.points[index]
    if (point) onPick(pointSearch(point))
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold">
          Size by release{' '}
          <span className="font-normal text-muted">
            {change
              ? `· ${bytes(change.first)} → ${bytes(change.last)} over ${change.measured}`
              : '· nothing measured yet'}
          </span>
        </h3>
        <Segmented
          aria-label="Compression"
          options={compressions}
          value={compression}
          onChange={setCompression}
        />
      </div>
      {series.points.length > 1 ? (
        <HistoryChart
          series={series}
          compression={compression}
          selectedKey={selectedKey}
          onSelect={pick}
        />
      ) : null}
      {failed ? (
        <p className="text-xs text-muted">
          {failed} of {series.points.length} measurements failed, usually an old release that no
          longer builds; they show as gaps.
        </p>
      ) : null}
      <Table label={`Measurements of ${series.name}`}>
        <thead>
          <tr>
            <Th>{series.source === 'package' ? 'Version' : 'Release'}</Th>
            <Th align="right">Size</Th>
            <Th align="right">Change</Th>
          </tr>
        </thead>
        <tbody>
          {historyRows(series, compression).map(({ point, index, size, delta }) => {
            const key = point.version ?? point.analysisId
            return (
              <tr
                key={key}
                className={key === selectedKey ? '[&>td]:bg-raise' : 'hover:[&>td]:bg-raise'}
              >
                <Td>
                  <button
                    type="button"
                    className="mono text-[12.5px] hover:underline"
                    onClick={() => pick(index)}
                    {...(key === selectedKey ? { 'aria-current': true } : {})}
                  >
                    {pointLabel(point)}
                  </button>
                  <div className="text-[11px] text-dim">
                    {point.at ? point.at.slice(0, 10) : point.measuredAt.slice(0, 10)}
                  </div>
                </Td>
                <Td align="right" className="tabular mono">
                  {point.status === 'failed' ? (
                    <Tag tone="danger" dot>
                      Build failed
                    </Tag>
                  ) : (
                    bytes(size)
                  )}
                </Td>
                <Td align="right">
                  <Delta value={delta} />
                </Td>
              </tr>
            )
          })}
        </tbody>
      </Table>
    </div>
  )
}

function ReportTab({
  row,
  tab,
  pick,
}: {
  row: BundleRow
  tab: Exclude<BundleTab, 'history'>
  pick: BundlePointPick
}) {
  const report = useBundleReport(row.repo, { target: row.name, ...pick })
  if (report.isPending) return <Placeholder className="h-72" />
  if (report.isError) return <ErrorState error={report.error} />
  const sections = sheetSections(report.data.report.sections, tab)
  if (!sections.length)
    return (
      <EmptyState
        icon={<Package />}
        title={`No ${tabLabels[tab].toLowerCase()} in this measurement`}
        description={
          row.source === 'package'
            ? 'Published packages are measured as an archive; their composition shows for app builds.'
            : 'The measurement failed or did not record this part.'
        }
      />
    )
  return (
    <div className="flex flex-col gap-6">
      {sections.map((section) => (
        <section key={section.id} className="flex min-w-0 flex-col gap-3">
          {sections.length > 1 || section.description ? (
            <div>
              <h3 className="text-[13px] font-semibold">{section.title}</h3>
              {section.description ? (
                <p className="text-xs text-muted">{section.description}</p>
              ) : null}
            </div>
          ) : null}
          {section.blocks.map((block, index) => (
            <BlockView key={`${block.type}-${index}`} block={block} />
          ))}
        </section>
      ))}
    </div>
  )
}

function budgetProgress(row: BundleRow) {
  const share = budgetShare(row)
  if (share === undefined || row.gzip === undefined || !row.budget) return undefined
  const state = budgetState(row)
  const over = row.gzip - row.budget
  return {
    segments: [
      {
        value: Math.min(row.gzip, row.budget),
        tone: budgetStateTone[state],
        label: 'used',
      },
      ...(over > 0 ? [{ value: over, tone: 'danger' as const, label: 'over' }] : []),
    ],
    total: Math.max(row.gzip, row.budget),
    label: (
      <>
        <b className="mono font-semibold text-foreground">{bytes(row.gzip)}</b> of{' '}
        <span className="mono">{bytes(row.budget)}</span> budget ·{' '}
        {over > 0 ? `${bytes(over)} over` : `${Math.round(share * 100)}% used`}
      </>
    ),
  }
}

/**
 * One bundle target in the side sheet: budget bar, facts, and tabs Composition, Entrypoints and
 * Packages (the stored report of the picked measurement, read-only) and History (every
 * measurement of the target, which picks the one the other tabs show).
 */
export function BundleSheet({
  row,
  tab,
  pick,
  onTab,
  onPick,
  onClose,
  index,
  total,
  onPrevious,
  onNext,
}: {
  row: BundleRow | undefined
  tab: BundleTab | undefined
  pick: BundlePointPick
  onTab: (tab: BundleTab) => void
  onPick: (pick: BundlePointPick) => void
  onClose: () => void
  index?: number
  total?: number
  onPrevious?: () => void
  onNext?: () => void
}) {
  const run = useRunJob({
    analyzer: 'bundle',
    label: 'Measure now',
    ...(row ? { repo: row.repo } : {}),
  })
  const backfill = useBackfillReleases('bundle', row?.repo)
  if (!row) return null
  const current = tab ?? 'composition'
  const state = budgetState(row)
  const progress = budgetProgress(row)
  const release = rowRelease(row)
  const selectedKey = pick.version ?? pick.analysis
  const measure = run.action?.onPress
    ? { label: 'Measure now', icon: Play, onPress: run.action.onPress }
    : undefined
  const past = backfill.item?.onAction
    ? { label: 'Analyze past releases', icon: History, onPress: backfill.item.onAction }
    : undefined
  const single = measure ?? past
  const quietActions =
    measure && past ? ([measure, past] as const) : single ? ([single] as const) : undefined
  return (
    <>
      <SideSheet
        open
        onClose={onClose}
        id={row.analysisId.slice(0, 8)}
        copyId={row.analysisId}
        title={row.name}
        {...(index !== undefined && total !== undefined ? { index, total } : {})}
        {...(onPrevious ? { onPrevious } : {})}
        {...(onNext ? { onNext } : {})}
        openAsPage={{ to: '/analyses/$id', params: { id: row.analysisId } }}
        {...(progress ? { progress } : {})}
        {...(quietActions ? { quietActions } : {})}
        tabs={{
          items: bundleTabs.map((id) => ({ id, label: tabLabels[id] })),
          selected: current,
          onSelect: (id) => onTab(bundleTabs.find((entry) => entry === id) ?? 'composition'),
          'aria-label': 'Bundle details',
        }}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <Tag>{row.source === 'package' ? 'Package' : 'App'}</Tag>
            <Tag tone={budgetStateTone[state]} dot>
              {budgetStateLabel[state]}
            </Tag>
          </div>
          <KeyValue
            rows={[
              {
                label: 'Repository',
                value: (
                  <Link
                    to="/repos/$"
                    params={{ _splat: repoSplat(row.repo) }}
                    search={{ tab: 'quality', section: 'bundles' }}
                    className="mono truncate hover:underline"
                  >
                    {row.repo.path}
                  </Link>
                ),
              },
              { label: 'Release', value: release ? <span className="mono">{release}</span> : null },
              {
                label: 'Measured',
                value: (
                  <span title={formatDateTime(row.createdAt)}>{formatRelative(row.createdAt)}</span>
                ),
              },
              {
                label: 'Total, gzip',
                value:
                  row.gzip === undefined ? null : (
                    <span className="flex items-baseline gap-2">
                      <span className="mono">{bytes(row.gzip)}</span>
                      <Delta value={row.delta} />
                    </span>
                  ),
              },
              {
                label: 'Largest entrypoint',
                value:
                  row.initial === undefined ? null : (
                    <span className="mono">{bytes(row.initial)} initial</span>
                  ),
              },
              {
                label: 'Showing',
                value: selectedKey ? (
                  <span className="flex items-center gap-2">
                    <span className="mono">{pick.version ?? pick.analysis?.slice(0, 8)}</span>
                    <button
                      type="button"
                      className="text-xs text-muted hover:text-foreground"
                      onClick={() => onPick({})}
                    >
                      Back to newest
                    </button>
                  </span>
                ) : null,
              },
            ]}
          />
          {current === 'history' ? (
            <HistoryTab row={row} selectedKey={selectedKey} onPick={onPick} />
          ) : (
            <ReportTab row={row} tab={current} pick={pick} />
          )}
        </div>
      </SideSheet>
      {run.dialog}
      {backfill.dialog}
    </>
  )
}
