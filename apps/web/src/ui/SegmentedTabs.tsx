import { Link, type LinkProps } from '@tanstack/react-router'
import type { ComponentType, ReactNode } from 'react'

export interface SegmentedTab {
  id: string
  label: ReactNode
  icon?: ComponentType<{ className?: string }>
  /** Where the tab leads; without it the tab is a button that calls `onSelect`. */
  link?: LinkProps
}

const itemClass = (current: boolean) =>
  `inline-flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[12.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-focus ${
    current
      ? 'bg-panel text-foreground shadow-[0_0_0_1px_var(--line-strong)]'
      : 'text-muted hover:text-foreground'
  }`

/** A row of connected tabs where exactly one is current; tabs are links or buttons. */
export function SegmentedTabs({
  items,
  selected,
  onSelect,
  'aria-label': ariaLabel,
  className = '',
}: {
  items: readonly SegmentedTab[]
  selected?: string
  onSelect?: (id: string) => void
  'aria-label': string
  className?: string
}) {
  return (
    <nav
      aria-label={ariaLabel}
      className={`inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg border border-line bg-raise p-0.5 ${className}`}
    >
      {items.map((item) => {
        const current = item.id === selected
        const content = (
          <>
            {item.icon ? <item.icon className="size-3.5" /> : null}
            {item.label}
          </>
        )
        return item.link ? (
          <Link
            key={item.id}
            {...item.link}
            aria-current={current ? 'page' : undefined}
            className={itemClass(current)}
          >
            {content}
          </Link>
        ) : (
          <button
            key={item.id}
            type="button"
            aria-pressed={current}
            onClick={() => onSelect?.(item.id)}
            className={itemClass(current)}
          >
            {content}
          </button>
        )
      })}
    </nav>
  )
}
