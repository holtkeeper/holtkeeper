import type { ReactNode } from 'react'

/** Scrollable data table frame; use `Th` and `Td` inside. */
export function Table({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table aria-label={label} className="w-full border-separate border-spacing-0 text-sm">
        {children}
      </table>
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
      className={`whitespace-nowrap border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted text-${align} ${className ?? ''}`}
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
