import type { Severity } from '@holtkeeper/api'

import { severityLabel } from '../lib/severity.ts'

const severityBg: Record<Severity, string> = {
  critical: 'bg-sev-critical',
  high: 'bg-sev-high',
  medium: 'bg-sev-medium',
  low: 'bg-sev-low',
  unknown: 'bg-sev-unknown',
}

/** CSS color of a severity, for SVG fills and strokes. */
const severityColor = (severity: Severity) => `var(--sev-${severity})`

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
