import { Link, type LinkProps } from '@tanstack/react-router'
import type { KeyboardEvent, ReactNode } from 'react'

/** One tab of an underline tab bar; with `link` it navigates, otherwise it calls `onSelect`. Give every tab a `link` or none. */
export interface UnderlineTab {
  id: string
  label: ReactNode
  /** A small count or tag after the label. */
  badge?: ReactNode
  link?: LinkProps
}

const itemClass = (current: boolean) =>
  `-mb-px inline-flex h-[38px] shrink-0 items-center gap-1.5 whitespace-nowrap border-b-[1.5px] text-[12.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-focus ${
    current
      ? 'border-foreground text-foreground'
      : 'border-transparent text-muted hover:text-foreground'
  }`

const badgeOf = (item: UnderlineTab) => (
  <>
    {item.label}
    {item.badge !== undefined ? (
      <span className="tabular text-[11px] text-dim">{item.badge}</span>
    ) : null}
  </>
)

const step = { ArrowRight: 1, ArrowLeft: -1 } as const

/**
 * A row of tabs under a header, the current one underlined. Tabs with `link` render as a `nav`
 * of links; otherwise the row is a `tablist` whose tabs call `onSelect`, moved through with the
 * arrow keys, Home and End.
 */
export function UnderlineTabs({
  items,
  selected,
  onSelect,
  'aria-label': ariaLabel,
  className = '',
}: {
  items: readonly UnderlineTab[]
  selected?: string
  onSelect?: (id: string) => void
  'aria-label': string
  className?: string
}) {
  const rowClass = `flex gap-5 overflow-x-auto border-b border-line px-4 ${className}`
  if (items.some((item) => item.link)) {
    return (
      <nav aria-label={ariaLabel} className={rowClass}>
        {items.map((item) => {
          const current = item.id === selected
          return (
            <Link
              key={item.id}
              {...item.link}
              aria-current={current ? 'page' : undefined}
              className={itemClass(current)}
            >
              {badgeOf(item)}
            </Link>
          )
        })}
      </nav>
    )
  }
  const focusable = items.some((item) => item.id === selected) ? selected : items[0]?.id
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = items.findIndex((item) => item.id === selected)
    const target =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowRight' || event.key === 'ArrowLeft'
            ? (Math.max(at, 0) + step[event.key] + items.length) % items.length
            : undefined
    const next = target === undefined ? undefined : items[target]
    if (!next) return
    event.preventDefault()
    onSelect?.(next.id)
    event.currentTarget.querySelector<HTMLElement>(`[data-tab="${CSS.escape(next.id)}"]`)?.focus()
  }
  return (
    <div role="tablist" aria-label={ariaLabel} onKeyDown={onKeyDown} className={rowClass}>
      {items.map((item) => {
        const current = item.id === selected
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            data-tab={item.id}
            aria-selected={current}
            tabIndex={item.id === focusable ? 0 : -1}
            onClick={() => onSelect?.(item.id)}
            className={itemClass(current)}
          >
            {badgeOf(item)}
          </button>
        )
      })}
    </div>
  )
}
