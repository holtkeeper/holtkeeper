import type { ReactNode } from 'react'

import { Dot, type DotTone } from './Legend.tsx'

/**
 * One figure of a `Strip`.
 *
 * @public
 */
export interface StripCell {
  /** Text after the value, e.g. "healthy" in "52 healthy". */
  label: ReactNode
  value: ReactNode
  /** Text before the value, e.g. "Updates" in "Updates 3 webhook". */
  prefix?: ReactNode
  /** Status dot before the value; the label must name the status too. */
  tone?: DotTone
  /** Quiet text after the label, e.g. "· 2 this week". */
  caption?: ReactNode
  /** Pushes this cell and the ones after it to the right edge. */
  end?: boolean
}

/**
 * A summary line of figures above a table: each cell reads "**value** label caption" with an
 * optional status dot, wrapping on narrow screens, with a hairline below.
 *
 * @public
 */
export function Strip({
  cells,
  label = 'Summary',
  className = '',
}: {
  cells: readonly StripCell[]
  label?: string
  className?: string
}) {
  return (
    <ul
      aria-label={label}
      className={`flex flex-wrap items-center gap-x-[18px] gap-y-1.5 border-b border-line px-3.5 py-2.5 text-xs text-muted ${className}`}
    >
      {cells.map((cell, index) => (
        <li
          key={index}
          className={`inline-flex min-w-0 items-center gap-1.5 ${cell.end ? 'ms-auto' : ''}`}
        >
          {cell.tone ? <Dot tone={cell.tone} /> : null}
          <span>
            {cell.prefix ? <>{cell.prefix} </> : null}
            <b className="tabular font-semibold text-foreground">{cell.value}</b> {cell.label}
            {cell.caption ? <span className="text-dim"> {cell.caption}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  )
}
