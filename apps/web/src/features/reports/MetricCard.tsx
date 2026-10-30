import type { Metric } from '@holtkeeper/api'
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import { motion } from 'motion/react'

import { deltaTone, formatDelta, formatValue, toneColor } from '../../lib/units.ts'
import { AnimatedNumber, Tooltip } from '../../ui/index.ts'

/** A headline metric with an animated value and its change, colored by whether it improved. */
export function MetricCard({ metric }: { metric: Metric }) {
  const unit = metric.unit ?? 'count'
  const tone = deltaTone(metric.delta, metric.better)
  const Arrow = !metric.delta ? Minus : metric.delta > 0 ? ArrowUpRight : ArrowDownRight
  return (
    <motion.div
      variants={{ hidden: { opacity: 0, y: 8 }, shown: { opacity: 1, y: 0 } }}
      className="relative flex flex-col gap-1 overflow-hidden rounded-2xl border border-border bg-surface p-4 shadow-surface"
    >
      {metric.tone ? (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-1"
          style={{ background: toneColor[metric.tone] }}
        />
      ) : null}
      <span className="truncate text-sm text-muted">{metric.label}</span>
      <span className="truncate text-2xl font-semibold tracking-tight">
        {typeof metric.value === 'number' ? (
          <AnimatedNumber
            value={metric.value}
            format={(v) =>
              formatValue(
                unit === 'count' && Number.isInteger(metric.value) ? Math.round(v) : v,
                unit,
              )
            }
          />
        ) : (
          formatValue(metric.value, unit)
        )}
      </span>
      {metric.delta !== undefined ? (
        <Tooltip
          content={
            metric.better === 'down'
              ? 'Lower is better'
              : metric.better === 'up'
                ? 'Higher is better'
                : 'Change since the compared report'
          }
        >
          <span
            tabIndex={0}
            className="inline-flex w-fit items-center gap-0.5 rounded-md text-xs font-medium tabular"
            style={{ color: tone === 'neutral' ? 'var(--muted)' : toneColor[tone] }}
          >
            <Arrow className="size-3.5" />
            {formatDelta(metric.delta, unit)}
            <span className="sr-only">
              {tone === 'good' ? ' (improved)' : tone === 'bad' ? ' (worse)' : ''}
            </span>
          </span>
        </Tooltip>
      ) : null}
      {metric.hint ? <span className="text-xs text-muted">{metric.hint}</span> : null}
    </motion.div>
  )
}
