import type { Block, Unit } from '@holtkeeper/api'
import type { ReactNode } from 'react'
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Cell as PieCell,
  Line,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { formatValue, toneColor } from '../../../lib/units.ts'
import { seriesColor } from '../tone.tsx'

type ChartBlockData = Extract<Block, { type: 'chart' }>

const axisTick = { fill: 'var(--chart-axis)', fontSize: 12 }

function TooltipBox({
  title,
  rows,
}: {
  title: ReactNode
  rows: { label: string; color: string; value: string }[]
}) {
  return (
    <div className="min-w-36 rounded-xl border border-border bg-overlay p-2.5 text-xs shadow-overlay">
      <div className="mb-1.5 font-medium">{title}</div>
      {rows.map((row) => (
        <div key={row.label} className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5 text-muted">
            <span className="size-2 rounded-full" style={{ background: row.color }} />
            {row.label}
          </span>
          <span className="tabular font-medium">{row.value}</span>
        </div>
      ))}
    </div>
  )
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  if (items.length < 2) return null
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Legend">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ background: item.color }} />
          {item.label}
        </li>
      ))}
    </ul>
  )
}

const numberOf = (value: string | number | null | undefined) =>
  typeof value === 'number' ? value : Number(value ?? 0) || 0

/** The number at `key`, or `null` for gaps. */
const valueOf = (datum: ChartBlockData['data'][number], key: string) => {
  const value = datum[key]
  if (value === null || value === undefined || value === '') return null
  return numberOf(value)
}

function Donut({ block, unit }: { block: ChartBlockData; unit: Unit }) {
  const key = block.series[0]?.key ?? 'value'
  const slices = block.data.map((datum, index) => ({
    name: String(datum[block.x] ?? index),
    value: numberOf(datum[key]),
    color: seriesColor(index),
  }))
  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  return (
    <div className="grid items-center gap-4 sm:grid-cols-[14rem_1fr]">
      <div
        className="h-56"
        role="img"
        aria-label={`${block.title ?? 'Share'}: ${slices.map((s) => `${s.name} ${formatValue(s.value, unit)}`).join(', ')}`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              innerRadius="58%"
              outerRadius="92%"
              paddingAngle={1.5}
              stroke="var(--surface)"
              strokeWidth={2}
            >
              {slices.map((slice) => (
                <PieCell key={slice.name} fill={slice.color} />
              ))}
            </Pie>
            <Tooltip
              content={({ active, payload }) => {
                const name = payload?.[0]?.name
                const slice = slices.find((s) => s.name === name)
                if (!active || !slice) return null
                return (
                  <TooltipBox
                    title={slice.name}
                    rows={[
                      { label: 'Value', color: slice.color, value: formatValue(slice.value, unit) },
                    ]}
                  />
                )
              }}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="flex flex-col gap-1.5 text-sm">
        {slices.map((slice) => (
          <li key={slice.name} className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2">
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ background: slice.color }}
              />
              <span className="truncate">{slice.name}</span>
            </span>
            <span className="tabular text-muted">
              {formatValue(slice.value, unit)}
              {total ? (
                <span className="ml-2 text-xs">{Math.round((slice.value / total) * 100)}%</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const axisFor = (unit: Unit, id: string, orientation: 'left' | 'right') => (
  <YAxis
    yAxisId={id}
    orientation={orientation}
    tickLine={false}
    axisLine={false}
    tick={axisTick}
    width={64}
    tickFormatter={(v: number) => formatValue(v, unit)}
  />
)

/** Line, area or combo chart with optional p25–p75-style bands and vertical markers. */
function Composed({ block, unit }: { block: ChartBlockData; unit: Unit }) {
  const rightUnit = block.rightUnit ?? unit
  const fallback = block.chart === 'line' ? 'line' : block.chart === 'area' ? 'area' : 'bar'
  const series = block.series.map((s, index) => ({
    ...s,
    as: block.chart === 'combo' ? (s.as ?? 'bar') : fallback,
    axis: block.chart === 'combo' && s.axis === 'right' ? 'right' : 'left',
    color: s.tone ? toneColor[s.tone] : seriesColor(index),
  }))
  const bands = (block.bands ?? []).map((band, index) => ({
    ...band,
    key: `__band${index}`,
    color: band.tone ? toneColor[band.tone] : seriesColor(index),
  }))
  const hasRight = series.some((s) => s.axis === 'right')
  const data = block.data.map((datum) => {
    const row: Record<string, string | number | null | [number, number]> = { ...datum }
    for (const band of bands) {
      const low = valueOf(datum, band.low)
      const high = valueOf(datum, band.high)
      row[band.key] = low === null || high === null ? null : [low, high]
    }
    return row
  })
  const unitOf = (axis: string) => (axis === 'right' ? rightUnit : unit)

  return (
    <div className="flex flex-col gap-3">
      <div
        className="h-64 w-full"
        role="img"
        aria-label={`${block.title ?? 'Chart'} of ${series.map((s) => s.label).join(', ')} over ${block.data.length} ${block.x} values`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 12, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis
              dataKey={block.x}
              tickLine={false}
              axisLine={false}
              tick={axisTick}
              minTickGap={16}
            />
            {axisFor(unit, 'left', 'left')}
            {hasRight ? axisFor(rightUnit, 'right', 'right') : null}
            <Tooltip
              cursor={{ stroke: 'var(--border-tertiary)' }}
              content={({ active, label }) => {
                const datum = block.data.find((d) => String(d[block.x]) === String(label))
                if (!active || !datum) return null
                const rows = series.map((s) => {
                  const value = valueOf(datum, s.key)
                  return {
                    label: s.label,
                    color: s.color,
                    value: value === null ? '—' : formatValue(value, unitOf(s.axis)),
                  }
                })
                for (const band of bands) {
                  const low = valueOf(datum, band.low)
                  const high = valueOf(datum, band.high)
                  if (low !== null && high !== null)
                    rows.push({
                      label: band.label,
                      color: band.color,
                      value: `${formatValue(low, unit)} – ${formatValue(high, unit)}`,
                    })
                }
                return <TooltipBox title={String(label)} rows={rows} />
              }}
            />
            {bands.map((band) => (
              <Area
                key={band.key}
                yAxisId="left"
                dataKey={band.key}
                name={band.label}
                stroke="none"
                fill={band.color}
                fillOpacity={0.14}
                type="monotone"
                activeDot={false}
                isAnimationActive={false}
              />
            ))}
            {series.map((s) =>
              s.as === 'bar' ? (
                <Bar
                  key={s.key}
                  yAxisId={s.axis}
                  dataKey={s.key}
                  name={s.label}
                  fill={s.color}
                  fillOpacity={block.chart === 'combo' ? 0.55 : 1}
                  radius={[4, 4, 0, 0]}
                  maxBarSize={36}
                />
              ) : s.as === 'area' ? (
                <Area
                  key={s.key}
                  yAxisId={s.axis}
                  dataKey={s.key}
                  name={s.label}
                  stroke={s.color}
                  fill={s.color}
                  fillOpacity={0.15}
                  strokeWidth={2}
                  type="monotone"
                  {...(s.dashed ? { strokeDasharray: '5 4' } : {})}
                />
              ) : (
                <Line
                  key={s.key}
                  yAxisId={s.axis}
                  dataKey={s.key}
                  name={s.label}
                  stroke={s.color}
                  strokeWidth={s.dashed ? 1.5 : 2.25}
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }}
                  type="monotone"
                  {...(s.dashed ? { strokeDasharray: '5 4', strokeOpacity: 0.8 } : {})}
                />
              ),
            )}
            {(block.markers ?? []).map((marker) => (
              <ReferenceLine
                key={`${marker.x}:${marker.label}`}
                yAxisId="left"
                x={marker.x}
                stroke={toneColor[marker.tone ?? 'neutral']}
                strokeDasharray="3 3"
                label={{
                  value: marker.label,
                  position: 'insideTopLeft',
                  fill: toneColor[marker.tone ?? 'neutral'],
                  fontSize: 11,
                }}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <Legend items={[...series, ...bands]} />
    </div>
  )
}

/** Bar, stacked bar, line, area, combo or donut chart with theme-aware tone colors. */
export function ChartBlock({ block }: { block: ChartBlockData }) {
  const unit = block.unit ?? 'count'
  if (block.chart === 'donut') return <Donut block={block} unit={unit} />
  if (block.chart !== 'bar' && block.chart !== 'stacked-bar')
    return <Composed block={block} unit={unit} />

  const series = block.series.map((s, index) => ({
    ...s,
    color: s.tone ? toneColor[s.tone] : seriesColor(index),
  }))
  const stacked = block.chart === 'stacked-bar'
  const margin = { top: 8, right: 8, bottom: 0, left: 0 }

  return (
    <div className="flex flex-col gap-3">
      <div
        className="h-64 w-full"
        role="img"
        aria-label={`${block.title ?? 'Chart'} of ${series.map((s) => s.label).join(', ')} over ${block.data.length} ${block.x} values`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={[...block.data]} margin={margin} barCategoryGap="24%">
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis
              dataKey={block.x}
              tickLine={false}
              axisLine={false}
              tick={axisTick}
              minTickGap={16}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tick={axisTick}
              width={64}
              tickFormatter={(v: number) => formatValue(v, unit)}
            />
            <Tooltip
              cursor={{ fill: 'var(--default-soft)' }}
              content={({ active, label }) => {
                const datum = block.data.find((d) => String(d[block.x]) === String(label))
                if (!active || !datum) return null
                return (
                  <TooltipBox
                    title={String(label)}
                    rows={series.map((s) => ({
                      label: s.label,
                      color: s.color,
                      value: formatValue(numberOf(datum[s.key]), unit),
                    }))}
                  />
                )
              }}
            />
            {series.map((s, index) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                fill={s.color}
                {...(stacked ? { stackId: 'stack' } : {})}
                radius={stacked && index < series.length - 1 ? 0 : [4, 4, 0, 0]}
                maxBarSize={48}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <Legend items={series} />
    </div>
  )
}
