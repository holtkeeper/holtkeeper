import { type StatusTone, statusColor } from './colors.ts'

export interface Segment {
  value: number
  tone: StatusTone
  label: string
}

/**
 * Segmented progress: one bar per segment, sized by `value`. With `total` above the sum, the
 * remainder shows as an empty track. The accessible name lists every non-empty segment.
 */
export function SegmentBar({
  segments,
  total,
  className = '',
}: {
  segments: readonly Segment[]
  total?: number
  className?: string
}) {
  const filled = segments.filter((s) => s.value > 0)
  const sum = filled.reduce((acc, s) => acc + s.value, 0)
  const rest = total !== undefined && total > sum ? total - sum : 0
  const label = filled.length ? filled.map((s) => `${s.value} ${s.label}`).join(', ') : 'Empty'
  return (
    <div
      role="img"
      aria-label={total === undefined ? label : `${label} of ${total}`}
      className={`flex h-1.5 w-full gap-0.5 ${className}`}
    >
      {filled.map((segment, index) => (
        <span
          key={index}
          className="h-full min-w-0.5 rounded-sm"
          style={{ flexGrow: segment.value, flexBasis: 0, background: statusColor[segment.tone] }}
        />
      ))}
      {rest > 0 || !filled.length ? (
        <span
          className="h-full rounded-sm bg-line-strong"
          style={{ flexGrow: rest || 1, flexBasis: 0 }}
        />
      ) : null}
    </div>
  )
}
