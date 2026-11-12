import type { ReactNode } from 'react'

/**
 * A small muted badge with a tabular number, e.g. after a tab or section title.
 *
 * @public
 */
export function Count({
  children,
  tone,
  label,
  className = '',
}: {
  children: ReactNode
  /** `warning` tints the count when it needs attention. */
  tone?: 'warning'
  /** Text read out instead of the bare number, e.g. "4 unread". */
  label?: string
  className?: string
}) {
  return (
    <span
      className={`tabular inline-block rounded border bg-chip px-[5px] text-[11px] leading-4 ${tone === 'warning' ? 'border-[color-mix(in_oklab,var(--warn)_30%,transparent)] text-warn' : 'border-line text-muted'} ${className}`}
    >
      {label ? (
        <>
          <span aria-hidden>{children}</span>
          <span className="sr-only">{label}</span>
        </>
      ) : (
        children
      )}
    </span>
  )
}
