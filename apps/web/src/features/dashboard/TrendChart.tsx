import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import type { TrendPoint } from '../../lib/dashboard.ts'
import { severities, severityLabel } from '../../lib/severity.ts'
import { severityBg, severityColor } from '../../ui/index.ts'

const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })

/** Stacked area of active findings by severity over time. */
export function TrendChart({ points }: { points: TrendPoint[] }) {
  const stack = severities.toReversed()
  return (
    <div className="flex flex-col gap-3">
      <div
        className="h-64 w-full"
        role="img"
        aria-label={`Active findings over ${points.length} days, from ${points[0]?.total ?? 0} to ${points.at(-1)?.total ?? 0}`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
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
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              width={48}
              tick={{ fill: 'var(--chart-axis)', fontSize: 12 }}
            />
            <Tooltip
              cursor={{ stroke: 'var(--border-tertiary)', strokeWidth: 1 }}
              content={({ active, label }) => {
                const point = points.find((p) => p.day === label)
                if (!active || !point) return null
                return (
                  <div className="min-w-40 rounded-xl border border-border bg-overlay p-3 text-xs shadow-overlay">
                    <div className="mb-2 font-medium">{dayLabel(point.day)}</div>
                    {severities.map((severity) => (
                      <div
                        key={severity}
                        className="flex items-center justify-between gap-4 py-0.5"
                      >
                        <span className="flex items-center gap-1.5 text-muted">
                          <span className={`size-2 rounded-full ${severityBg[severity]}`} />
                          {severityLabel[severity]}
                        </span>
                        <span className="tabular font-medium">{point[severity]}</span>
                      </div>
                    ))}
                    <div className="mt-1.5 flex justify-between border-t border-separator pt-1.5 font-medium">
                      <span>Total</span>
                      <span className="tabular">{point.total}</span>
                    </div>
                  </div>
                )
              }}
            />
            {stack.map((severity) => (
              <Area
                key={severity}
                type="monotone"
                dataKey={severity}
                stackId="severity"
                stroke={severityColor(severity)}
                strokeWidth={2}
                fill={severityColor(severity)}
                fillOpacity={0.18}
                animationDuration={800}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Legend">
        {severities.map((severity) => (
          <li key={severity} className="flex items-center gap-1.5">
            <span className={`size-2 rounded-full ${severityBg[severity]}`} />
            {severityLabel[severity]}
          </li>
        ))}
      </ul>
    </div>
  )
}
