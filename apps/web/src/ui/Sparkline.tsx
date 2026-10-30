import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

/** Tiny trend line of one series; `label` describes it for screen readers. */
export function Sparkline({
  points,
  label,
  color = 'var(--series-1)',
  height = 36,
}: {
  points: readonly { at: string; value: number }[]
  label: string
  color?: string
  height?: number
}) {
  if (points.length < 2)
    return (
      <div style={{ height }} className="flex items-center text-xs text-muted">
        —
      </div>
    )
  const id = `spark-${label.replace(/[^a-z0-9]/gi, '')}`
  return (
    <div role="img" aria-label={label} style={{ height }} className="w-full min-w-24">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={[...points]} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="at" hide />
          <YAxis hide domain={[0, 'dataMax']} />
          <Tooltip
            cursor={{ stroke: 'var(--border-tertiary)' }}
            content={({ active, label: at }) => {
              const point = points.find((p) => p.at === at)
              if (!active || !point) return null
              return (
                <div className="rounded-lg border border-border bg-overlay px-2 py-1 text-xs shadow-overlay">
                  <span className="tabular font-medium">{point.value}</span> active ·{' '}
                  {new Date(point.at).toLocaleDateString()}
                </div>
              )
            }}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={2}
            fill={`url(#${id})`}
            isAnimationActive
            animationDuration={700}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 2, stroke: 'var(--surface)' }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
