import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { type DayPoint, formatTokens, formatUsd } from '../../lib/ai-usage.ts'

const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })

const axisUsd = (value: number) => (value >= 100 ? `$${Math.round(value)}` : `$${value}`)

/** Daily AI spend as bars, with runs and tokens in the tooltip. */
export function CostChart({ points }: { points: DayPoint[] }) {
  const total = points.reduce((sum, point) => sum + point.costUsd, 0)
  return (
    <div
      className="h-64 w-full"
      role="img"
      aria-label={`AI spend over ${points.length} days, ${formatUsd(total)} in total`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis
            dataKey="day"
            tickFormatter={dayLabel}
            tickLine={false}
            axisLine={false}
            minTickGap={32}
            tick={{ fill: 'var(--chart-axis)', fontSize: 12 }}
          />
          <YAxis
            tickFormatter={axisUsd}
            tickLine={false}
            axisLine={false}
            width={56}
            tick={{ fill: 'var(--chart-axis)', fontSize: 12 }}
          />
          <Tooltip
            cursor={{ fill: 'var(--chart-grid)' }}
            content={({ active, label }) => {
              const point = points.find((p) => p.day === label)
              if (!active || !point) return null
              return (
                <div className="min-w-36 rounded-xl border border-border bg-overlay p-3 text-xs shadow-overlay">
                  <div className="mb-2 font-medium">{dayLabel(point.day)}</div>
                  {[
                    ['Cost', formatUsd(point.costUsd)],
                    ['Runs', String(point.runs)],
                    ['Tokens', formatTokens(point.tokens)],
                  ].map(([name, value]) => (
                    <div key={name} className="flex justify-between gap-4 py-0.5">
                      <span className="text-muted">{name}</span>
                      <span className="tabular font-medium">{value}</span>
                    </div>
                  ))}
                </div>
              )
            }}
          />
          <Bar
            dataKey="costUsd"
            fill="var(--series-1)"
            radius={[4, 4, 0, 0]}
            maxBarSize={28}
            animationDuration={800}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
