import type { Metric } from '@holtkeeper/api'

import { deltaTone, formatDelta, formatValue, toneColor } from '../../lib/units.ts'

/** Headline metrics as small tiles: label, value colored by its tone, change since last time. */
export function MetricTiles({
  metrics,
  limit = 3,
  className = 'grid grid-cols-3 gap-2',
}: {
  metrics: readonly Metric[]
  limit?: number
  className?: string
}) {
  return (
    <dl className={className}>
      {metrics.slice(0, limit).map((metric) => {
        const delta = deltaTone(metric.delta, metric.better)
        const tone = metric.tone && metric.tone !== 'neutral' ? toneColor[metric.tone] : undefined
        return (
          <div
            key={metric.id}
            className="min-w-0 rounded-xl bg-default-soft px-2.5 py-2"
            title={metric.hint}
          >
            <dt className="truncate text-[11px] text-muted">{metric.label}</dt>
            <dd className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
              <span
                className="tabular text-[15px] font-semibold leading-tight"
                style={tone ? { color: tone } : undefined}
              >
                {formatValue(metric.value, metric.unit)}
              </span>
              {metric.delta ? (
                <span
                  className="tabular text-[11px]"
                  style={{ color: delta === 'neutral' ? 'var(--muted)' : toneColor[delta] }}
                >
                  {formatDelta(metric.delta, metric.unit)}
                </span>
              ) : null}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}
