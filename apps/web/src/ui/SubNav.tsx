import { Link, type LinkProps } from '@tanstack/react-router'
import { type ComponentType, type ReactNode, useRef } from 'react'

import { Kbd, SearchInput } from './Misc.tsx'
import { useSlashFocus } from './useSlashFocus.ts'

/** One entry of a `SubNav`. */
export interface SubNavItem {
  id: string
  label: ReactNode
  icon?: ComponentType<{ className?: string }>
  link: LinkProps
  /** Shown on the right of the entry, e.g. a count. */
  meta?: ReactNode
}

/** One search result of a `SubNav`: a link with where it leads. */
interface SubNavResult {
  id: string
  label: ReactNode
  /** Second line, e.g. where the result lives. */
  detail?: ReactNode
  link: LinkProps
}

/** A titled block of search results. */
export interface SubNavResultGroup {
  label: string
  results: readonly SubNavResult[]
}

const itemClass = (current: boolean) =>
  `flex h-[30px] min-w-0 items-center gap-2 rounded-[7px] px-2 text-[12.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-focus ${
    current
      ? 'bg-raise text-foreground shadow-[inset_0_0_0_1px_var(--line-strong)]'
      : 'text-muted hover:bg-raise hover:text-foreground'
  }`

/**
 * The left sub-navigation of a page with sections (Settings, Account): an optional search field
 * that `/` focuses, then the entries, with `selected` marked as the current page. While the
 * search has text, `search.results` replace the entries. `footer` sits at the bottom.
 */
export function SubNav({
  'aria-label': ariaLabel,
  heading,
  items,
  selected,
  search,
  footer,
}: {
  'aria-label': string
  /** Small label above the entries, e.g. "Organization". */
  heading?: string
  items: readonly SubNavItem[]
  selected?: string
  search?: {
    'aria-label': string
    value: string
    onChange: (value: string) => void
    results: readonly SubNavResultGroup[]
  }
  footer?: ReactNode
}) {
  const ref = useRef<HTMLInputElement>(null)
  useSlashFocus(ref, Boolean(search))
  const searching = Boolean(search?.value.trim())
  return (
    <nav
      aria-label={ariaLabel}
      className="flex w-full shrink-0 flex-col gap-0.5 border-b border-line px-2.5 py-3 md:w-[224px] md:border-r md:border-b-0"
    >
      {search ? (
        <div className="relative mb-2">
          <SearchInput
            aria-label={search['aria-label']}
            placeholder={search['aria-label']}
            value={search.value}
            onChange={search.onChange}
            inputRef={ref}
            className="w-full"
          />
          {search.value ? null : (
            <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center">
              <Kbd>/</Kbd>
            </span>
          )}
        </div>
      ) : null}
      {searching && search ? (
        search.results.length ? (
          search.results.map((group) => (
            <div key={group.label} className="flex flex-col gap-0.5">
              <span className="px-2 pt-3 pb-1 text-[11px] font-medium text-dim">{group.label}</span>
              {group.results.map((result) => (
                <Link
                  key={result.id}
                  {...result.link}
                  className="flex min-w-0 flex-col rounded-[7px] px-2 py-1.5 text-[12.5px] text-muted hover:bg-raise hover:text-foreground focus-visible:outline-2 focus-visible:outline-focus"
                >
                  <span className="truncate font-medium text-foreground">{result.label}</span>
                  {result.detail ? (
                    <span className="truncate text-[11px] text-dim">{result.detail}</span>
                  ) : null}
                </Link>
              ))}
            </div>
          ))
        ) : (
          <p className="px-2 py-3 text-xs text-muted">Nothing matches.</p>
        )
      ) : (
        <>
          {heading ? (
            <span className="px-2 pt-1 pb-1 text-[11px] font-medium text-dim">{heading}</span>
          ) : null}
          {items.map((item) => {
            const current = item.id === selected
            return (
              <Link
                key={item.id}
                {...item.link}
                aria-current={current ? 'page' : undefined}
                className={itemClass(current)}
              >
                {item.icon ? <item.icon className="size-[15px] shrink-0" /> : null}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.meta ? (
                  <span className="shrink-0 whitespace-nowrap text-[11px] text-dim">
                    {item.meta}
                  </span>
                ) : null}
              </Link>
            )
          })}
        </>
      )}
      {footer ? (
        <div className="mt-auto flex flex-col gap-1 px-2 pt-3 text-[11.5px] text-dim">{footer}</div>
      ) : null}
    </nav>
  )
}
