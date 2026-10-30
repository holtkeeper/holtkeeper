import type { Metric } from '@holtkeeper/api'

import { deltaTone, formatDelta, formatValue, toneColor } from '../../lib/units.ts'

/** Compact metric values with colored deltas, for list rows. */
export function MetricChips({
  metrics,
  limit = 3,
}: {
  metrics: readonly Metric[]
  limit?: number
}) {
  return (
    <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      {metrics.slice(0, limit).map((metric) => {
        const tone = deltaTone(metric.delta, metric.better)
        return (
          <span key={metric.id} className="flex items-baseline gap-1.5">
            <span className="text-muted">{metric.label}</span>
            <span className="tabular font-semibold">{formatValue(metric.value, metric.unit)}</span>
            {metric.delta ? (
              <span
                className="tabular"
                style={{ color: tone === 'neutral' ? 'var(--muted)' : toneColor[tone] }}
              >
                {formatDelta(metric.delta, metric.unit)}
              </span>
            ) : null}
          </span>
        )
      })}
    </span>
  )
}
