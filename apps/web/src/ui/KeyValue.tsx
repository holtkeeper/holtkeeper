import type { ReactNode } from 'react'

/**
 * One row of a `KeyValue` list; rows with an empty `value` are left out.
 *
 * @public
 */
export interface KeyValueRow {
  label: ReactNode
  value: ReactNode
}

/**
 * Labelled facts as a definition list: muted labels in a fixed column, values beside them.
 *
 * @public
 */
export function KeyValue({
  rows,
  labelWidth = 112,
  className = '',
}: {
  rows: readonly KeyValueRow[]
  /** Width of the label column in pixels. */
  labelWidth?: number
  className?: string
}) {
  const shown = rows.filter(
    (row) => row.value !== null && row.value !== undefined && row.value !== '',
  )
  return (
    <dl
      className={`m-0 grid gap-x-3 gap-y-[9px] text-[12.5px] ${className}`}
      style={{ gridTemplateColumns: `${labelWidth}px minmax(0, 1fr)` }}
    >
      {shown.map((row, index) => (
        <div key={index} className="contents">
          <dt className="text-muted">{row.label}</dt>
          <dd className="m-0 flex min-w-0 items-center gap-1.5">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}
