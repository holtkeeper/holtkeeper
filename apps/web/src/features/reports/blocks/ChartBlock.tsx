import type { Block, Unit } from '@holtkeeper/api'
import type { ReactNode } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell as PieCell,
  Line,
  LineChart,
  Pie,
  PieChart,
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

const numberOf = (value: string | number | undefined) =>
  typeof value === 'number' ? value : Number(value ?? 0) || 0

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

/** Bar, stacked bar, line, area or donut chart with theme-aware tone colors. */
export function ChartBlock({ block }: { block: ChartBlockData }) {
  const unit = block.unit ?? 'count'
  if (block.chart === 'donut') return <Donut block={block} unit={unit} />

  const series = block.series.map((s, index) => ({
    ...s,
    color: s.tone ? toneColor[s.tone] : seriesColor(index),
  }))
  const stacked = block.chart === 'stacked-bar'
  const tooltip = (
    <Tooltip
      cursor={
        block.chart === 'line' || block.chart === 'area'
          ? { stroke: 'var(--border-tertiary)' }
          : { fill: 'var(--default-soft)' }
      }
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
  )
  const axes = (
    <>
      <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
      <XAxis dataKey={block.x} tickLine={false} axisLine={false} tick={axisTick} minTickGap={16} />
      <YAxis
        tickLine={false}
        axisLine={false}
        tick={axisTick}
        width={64}
        tickFormatter={(v: number) => formatValue(v, unit)}
      />
      {tooltip}
    </>
  )
  const margin = { top: 8, right: 8, bottom: 0, left: 0 }
  const data = [...block.data]

  return (
    <div className="flex flex-col gap-3">
      <div
        className="h-64 w-full"
        role="img"
        aria-label={`${block.title ?? 'Chart'} of ${series.map((s) => s.label).join(', ')} over ${block.data.length} ${block.x} values`}
      >
        <ResponsiveContainer width="100%" height="100%">
          {block.chart === 'line' ? (
            <LineChart data={data} margin={margin}>
              {axes}
              {series.map((s) => (
                <Line
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  stroke={s.color}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  type="monotone"
                />
              ))}
            </LineChart>
          ) : block.chart === 'area' ? (
            <AreaChart data={data} margin={margin}>
              {axes}
              {series.map((s) => (
                <Area
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  stroke={s.color}
                  fill={s.color}
                  fillOpacity={0.15}
                  strokeWidth={2}
                  type="monotone"
                />
              ))}
            </AreaChart>
          ) : (
            <BarChart data={data} margin={margin} barCategoryGap="24%">
              {axes}
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
          )}
        </ResponsiveContainer>
      </div>
      <Legend items={series} />
    </div>
  )
}
