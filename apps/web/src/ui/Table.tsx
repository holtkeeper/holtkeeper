import type { ReactNode } from 'react'

/** Height cap of every data table; rows scroll inside under a sticky header. */
export const tableScrollClass = 'max-h-[min(70vh,48rem)] overflow-auto overscroll-contain'

/**
 * Data table frame with a capped height and a sticky header; use `Th` and `Td` inside.
 * `footer` sits inside the scroll area after the rows, the place for a `LoadMore`.
 */
export function Table({
  children,
  label,
  footer,
}: {
  children: ReactNode
  label: string
  footer?: ReactNode
}) {
  return (
    <div className={tableScrollClass}>
      <table aria-label={label} className="w-full border-separate border-spacing-0 text-sm">
        {children}
      </table>
      {footer ? <div className="py-3">{footer}</div> : null}
    </div>
  )
}

export function Th({
  children,
  align = 'left',
  className,
}: {
  children?: ReactNode
  align?: 'left' | 'right' | 'center'
  className?: string
}) {
  return (
    <th
      scope="col"
      className={`sticky top-0 z-[2] whitespace-nowrap border-b border-border bg-[var(--table-bg,var(--surface))] px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted text-${align} ${className ?? ''}`}
    >
      {children}
    </th>
  )
}

export function Td({
  children,
  align = 'left',
  className,
}: {
  children?: ReactNode
  align?: 'left' | 'right' | 'center'
  className?: string
}) {
  return (
    <td
      className={`border-b border-separator px-3 py-3 align-middle text-${align} ${className ?? ''}`}
    >
      {children}
    </td>
  )
}
