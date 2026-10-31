import type { BundleSeries, RepoRef } from '@holtkeeper/api'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Package } from 'lucide-react'
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
import { analysisPages } from '../../lib/analyses.ts'
import {
  type ChartRow,
  type Compression,
  type TargetRow,
  chartEntrypoints,
  chartRows,
  overallChange,
  pointLabel,
  pointSearch,
  targetRows,
} from '../../lib/bundles.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import { formatValue } from '../../lib/units.ts'
import {
  Chip,
  EmptyState,
  ErrorState,
  Page,
  Panel,
  Placeholder,
  SearchInput,
  Segmented,
  Table,
  Td,
  Th,
} from '../../ui/index.ts'
import { AnalysisRecords, RepoSelect } from '../analyses/AnalysesPage.tsx'
import { BackfillReleasesButton } from '../analyses/BackfillReleases.tsx'
import { RunJobButton } from '../jobs/RunJobDialog.tsx'
import { ReportView } from '../reports/ReportView.tsx'

const [, page] = analysisPages

const compressions = [
  { id: 'gzip', label: 'Gzip' },
  { id: 'brotli', label: 'Brotli' },
  { id: 'raw', label: 'Raw' },
] as const

/** Search parameters of the page. */
export interface BundlesSearch {
  repo?: string
  target?: string
  version?: string
  analysis?: string
}

const bytes = (value: number | null | undefined) => formatValue(value, 'bytes')

function Delta({ value }: { value: number | undefined }) {
  if (value === undefined) return <span className="text-muted">—</span>
  if (value === 0) return <span className="text-muted">0 B</span>
  return (
    <span className={`tabular ${value > 0 ? 'text-danger' : 'text-success'}`}>
      {value > 0 ? '+' : '−'}
      {bytes(Math.abs(value))}
    </span>
  )
}

function TargetTable({
  rows,
  selected,
  onSelect,
}: {
  rows: TargetRow[]
  selected: string | undefined
  onSelect: (name: string) => void
}) {
  const [query, setQuery] = useState('')
  const shown = query
    ? rows.filter((row) => row.name.toLowerCase().includes(query.toLowerCase()))
    : rows
  return (
    <Panel
      title="Targets"
      description="App builds and published packages, newest measurement of each"
      contentClassName="p-0"
      {...(rows.length > 8
        ? {
            actions: (
              <SearchInput
                aria-label="Find a target"
                placeholder="Find a target"
                value={query}
                onChange={setQuery}
                className="w-64"
              />
            ),
          }
        : {})}
    >
      <Table label="Bundle targets">
        <thead>
          <tr>
            <Th>Target</Th>
            <Th>Latest</Th>
            <Th align="right">Size</Th>
            <Th align="right">Change</Th>
            <Th align="right">History</Th>
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <tr key={row.name} className={row.name === selected ? 'bg-default/60' : undefined}>
              <Td>
                <button
                  type="button"
                  className="flex items-center gap-2 text-left font-mono text-sm hover:underline"
                  onClick={() => onSelect(row.name)}
                  aria-current={row.name === selected ? 'true' : undefined}
                >
                  {row.name}
                  {row.source === 'package' ? <Chip>package</Chip> : null}
                  {row.failed ? <Chip tone="danger">failed</Chip> : null}
                </button>
              </Td>
              <Td className="text-muted">{row.latest ? pointLabel(row.latest) : '—'}</Td>
              <Td align="right" className="tabular">
                {row.size === undefined ? '—' : bytes(row.size)}
              </Td>
              <Td align="right">
                <Delta value={row.delta} />
              </Td>
              <Td align="right" className="tabular text-muted">
                {row.points}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Panel>
  )
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
    <div className="flex flex-col gap-3">
      <div
        className="h-72 w-full"
        role="img"
        aria-label={`${series.name} over ${rows.length} measurements`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={rows}
            margin={{ top: 8, right: 16, bottom: 0, left: 8 }}
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
              tick={{ fill: 'var(--chart-axis)', fontSize: 12 }}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={72}
              tickFormatter={(value: number) => bytes(value)}
              tick={{ fill: 'var(--chart-axis)', fontSize: 12 }}
            />
            <Tooltip
              cursor={{ stroke: 'var(--border-tertiary)', strokeWidth: 1 }}
              content={({ active, label }) => {
                const row: ChartRow | undefined = rows.find((item) => item.label === label)
                if (!active || !row) return null
                return (
                  <div className="min-w-48 rounded-xl border border-border bg-overlay p-3 text-xs shadow-overlay">
                    <div className="mb-2 font-medium">
                      {row.label}
                      <span className="ml-2 text-muted">{row.at.slice(0, 10)}</span>
                    </div>
                    {row.status === 'failed' ? (
                      <div className="text-danger">Not measured</div>
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
                          <span className="tabular font-medium">{bytes(row[line.key])}</span>
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
                strokeWidth={line.key === 'total' ? 2.5 : 1.5}
                dot={{ r: rows.length > 40 ? 0 : 3 }}
                activeDot={{ r: 5, cursor: 'pointer' }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Legend">
        {lines.map((line, index) => (
          <li key={line.key} className="flex items-center gap-1.5">
            <span
              className="size-2 rounded-full"
              style={{ background: `var(--series-${index + 1})` }}
            />
            {line.label}
          </li>
        ))}
        {selected ? <li className="ml-auto">Selected: {selected.label}</li> : null}
      </ul>
    </div>
  )
}

function PointTable({
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
  const points = series.points.map((point, index) => {
    const size = point.total?.[compression]
    const before = series.points.slice(0, index).findLast((item) => item.status === 'ok')?.total?.[
      compression
    ]
    return {
      point,
      index,
      size,
      delta: size !== undefined && before !== undefined ? size - before : undefined,
    }
  })
  return (
    <Table label={`Measurements of ${series.name}`}>
      <thead>
        <tr>
          <Th>{series.source === 'package' ? 'Version' : 'Release'}</Th>
          <Th>Date</Th>
          <Th align="right">Size</Th>
          <Th align="right">Change</Th>
          {series.source === 'package' ? <Th align="right">Unpacked</Th> : null}
        </tr>
      </thead>
      <tbody>
        {points.toReversed().map(({ point, index, size, delta }) => {
          const key = point.version ?? point.analysisId
          return (
            <tr key={key} className={key === selectedKey ? 'bg-default/60' : undefined}>
              <Td>
                <button
                  type="button"
                  className="font-mono text-sm hover:underline"
                  onClick={() => onSelect(index)}
                >
                  {pointLabel(point)}
                </button>
                {point.status === 'failed' ? (
                  <span className="ml-2">
                    <Chip tone="danger">failed</Chip>
                  </span>
                ) : null}
              </Td>
              <Td className="text-muted">{point.at.slice(0, 10)}</Td>
              <Td align="right" className="tabular">
                {size === undefined ? '—' : bytes(size)}
              </Td>
              <Td align="right">
                <Delta value={delta} />
              </Td>
              {series.source === 'package' ? (
                <Td align="right" className="tabular text-muted">
                  {point.package ? bytes(point.package.unpacked) : '—'}
                </Td>
              ) : null}
            </tr>
          )
        })}
      </tbody>
    </Table>
  )
}

function RepoBundles({ repo, search }: { repo: RepoRef; search: BundlesSearch }) {
  const navigate = useNavigate()
  const [compression, setCompression] = useState<Compression>('gzip')
  const targets = useBundleTargets(repo)
  const series = targets.data?.series ?? []
  const rows = targetRows(series, compression)
  const name = search.target ?? rows[0]?.name ?? ''
  const selected = series.find((entry) => entry.name === name)
  const report = useBundleReport(
    repo,
    {
      target: name,
      ...(search.version ? { version: search.version } : {}),
      ...(search.analysis ? { analysis: search.analysis } : {}),
    },
    Boolean(selected),
  )

  const go = (next: Omit<BundlesSearch, 'repo'>) =>
    void navigate({ to: '/bundles', search: { repo: repoKey(repo), ...next } })
  const selectPoint = (index: number) => {
    const point = selected?.points[index]
    if (point) go({ target: name, ...pointSearch(point) })
  }
  const selectedKey =
    search.version ??
    search.analysis ??
    (selected?.points.at(-1)?.version || selected?.points.at(-1)?.analysisId)

  if (targets.isPending)
    return (
      <div className="flex flex-col gap-4">
        <Placeholder className="h-48" />
        <Placeholder className="h-72" />
      </div>
    )
  if (targets.isError) return <ErrorState error={targets.error} />
  if (!series.length)
    return (
      <Panel>
        <EmptyState
          icon={<Package />}
          title="Nothing measured yet"
          description="A run builds the apps of the repository and downloads the packages it publishes. Past releases can be measured too."
          action={<RunJobButton analyzer="bundle" label="Run now" size="sm" repo={repo} />}
        />
      </Panel>
    )

  const change = selected ? overallChange(selected, compression) : undefined
  const failures = selected?.points.filter((point) => point.status === 'failed') ?? []
  return (
    <div className="flex flex-col gap-6">
      {series.length > 1 ? (
        <TargetTable rows={rows} selected={name} onSelect={(target) => go({ target })} />
      ) : null}

      {selected ? (
        <Panel
          title={selected.name}
          description={
            change
              ? `${change.measured} measurements: ${bytes(change.first)} → ${bytes(change.last)}`
              : 'No successful measurement yet'
          }
          actions={
            <Segmented
              aria-label="Compression"
              options={compressions}
              value={compression}
              onChange={setCompression}
            />
          }
        >
          <div className="flex flex-col gap-6">
            {selected.points.length > 1 ? (
              <HistoryChart
                series={selected}
                compression={compression}
                selectedKey={selectedKey}
                onSelect={selectPoint}
              />
            ) : null}
            {failures.length ? (
              <p className="text-sm text-muted">
                {failures.length} of {selected.points.length} measurements failed (for old releases
                usually a build that no longer works); they show as gaps.
              </p>
            ) : null}
            <PointTable
              series={selected}
              compression={compression}
              selectedKey={selectedKey}
              onSelect={selectPoint}
            />
          </div>
        </Panel>
      ) : null}

      {report.isError ? (
        <ErrorState error={report.error} />
      ) : report.data ? (
        <ReportView report={report.data.report} />
      ) : selected ? (
        <Placeholder className="h-96" />
      ) : null}
    </div>
  )
}

/** Bundle sizes per app build and published package, with their history across releases. */
export function BundlesPage() {
  const search = useSearch({ strict: false }) as BundlesSearch
  const repo = parseRepoKey(search.repo)
  return (
    <Page
      title={page.title}
      icon={page.icon}
      description={repo ? `${page.description} · ${repoKey(repo)}` : page.description}
      actions={
        <div className="flex items-center gap-2">
          <RepoSelect to={page.to} />
          <BackfillReleasesButton repo={repo} bundle />
          <RunJobButton
            analyzer={page.kind}
            label="Run now"
            variant="secondary"
            {...(repo ? { repo } : {})}
          />
        </div>
      }
    >
      {repo ? <RepoBundles repo={repo} search={search} /> : <AnalysisRecords page={page} />}
    </Page>
  )
}
