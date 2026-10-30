import type { Severity, SeverityCounts } from '@holtkeeper/api'
import { motion } from 'motion/react'

import { severities, severityLabel } from '../lib/severity.ts'

/** Background utility per severity; also used by charts and legends. */
export const severityBg: Record<Severity, string> = {
  critical: 'bg-sev-critical',
  high: 'bg-sev-high',
  medium: 'bg-sev-medium',
  low: 'bg-sev-low',
  unknown: 'bg-sev-unknown',
}

/** CSS color of a severity, for SVG fills and strokes. */
export const severityColor = (severity: Severity) => `var(--sev-${severity})`

/** Severity as a dot plus label, so color is never the only signal. */
export function SeverityChip({
  severity,
  count,
  compact,
}: {
  severity: Severity
  count?: number
  compact?: boolean
}) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs font-medium"
      style={{ background: `color-mix(in oklab, ${severityColor(severity)} 12%, transparent)` }}
    >
      <span aria-hidden className={`size-2 rounded-full ${severityBg[severity]}`} />
      {compact ? null : severityLabel[severity]}
      {count === undefined ? null : <span className="tabular">{count}</span>}
    </span>
  )
}

/** Horizontal distribution of findings by severity, with an accessible text summary. */
export function SeverityBar({
  counts,
  height = 'h-2.5',
  showLegend = false,
}: {
  counts: SeverityCounts
  height?: string
  showLegend?: boolean
}) {
  const total = severities.reduce((sum, s) => sum + counts[s], 0)
  const label = total
    ? severities
        .filter((s) => counts[s] > 0)
        .map((s) => `${counts[s]} ${s}`)
        .join(', ')
    : 'No active findings'
  return (
    <div className="flex flex-col gap-2">
      <div
        role="img"
        aria-label={label}
        className={`flex w-full gap-0.5 overflow-hidden rounded-full bg-default ${height}`}
      >
        {severities.map((severity) =>
          counts[severity] > 0 ? (
            <motion.span
              key={severity}
              className={`${severityBg[severity]} h-full first:rounded-l-full last:rounded-r-full`}
              initial={{ width: 0 }}
              animate={{ width: `${(counts[severity] / total) * 100}%` }}
              transition={{ type: 'spring', stiffness: 160, damping: 26 }}
            />
          ) : null,
        )}
      </div>
      {showLegend ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          {severities.map((severity) => (
            <li key={severity} className="flex items-center gap-1.5">
              <span aria-hidden className={`size-2 rounded-full ${severityBg[severity]}`} />
              {severityLabel[severity]}
              <span className="tabular font-medium text-foreground">{counts[severity]}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
