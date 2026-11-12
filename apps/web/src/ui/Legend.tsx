import type { ReactNode } from 'react'

import { type StatusTone, statusColor } from './colors.ts'

/** Color of a status dot: a status tone, or `none` for missing data. */
export type DotTone = StatusTone | 'none'

const dotColor = (tone: DotTone): string => (tone === 'none' ? 'var(--dim)' : statusColor[tone])

/** A 6px status dot; decorative, so the text next to it must say the same. */
export function Dot({ tone, className = '' }: { tone: DotTone; className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block size-1.5 shrink-0 rounded-full ${className}`}
      style={{ background: dotColor(tone) }}
    />
  )
}

/**
 * One legend entry: a status dot, or a swatch for any CSS color, and its label.
 *
 * @public
 */
export type LegendItem = { label: ReactNode } & (
  | { tone: DotTone; color?: never }
  | { color: string; tone?: never }
)

/**
 * A row of legend entries so colors in a chart, strip or table never carry meaning alone.
 *
 * @public
 */
export function Legend({
  items,
  label = 'Legend',
  className = '',
}: {
  items: readonly LegendItem[]
  label?: string
  className?: string
}) {
  return (
    <ul
      aria-label={label}
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted ${className}`}
    >
      {items.map((item, index) => (
        <li key={index} className="inline-flex items-center gap-1.5">
          {item.color === undefined ? (
            <Dot tone={item.tone} />
          ) : (
            <span
              aria-hidden
              className="inline-block size-2 shrink-0 rounded-[2px]"
              style={{ background: item.color }}
            />
          )}
          {item.label}
        </li>
      ))}
    </ul>
  )
}
