import { Link, type LinkProps } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'

/** One step of a breadcrumb trail; every step but the last links somewhere. */
export interface Crumb {
  label: ReactNode
  link?: LinkProps
}

/** A breadcrumb trail above a page title: links to the parents, then the current page as text. */
export function Crumbs({ items }: { items: readonly Crumb[] }) {
  if (!items.length) return null
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
      {items.map((item, index) => {
        const last = index === items.length - 1
        return (
          <Fragment key={index}>
            {index > 0 ? <ChevronRight className="size-3 shrink-0 text-dim" aria-hidden /> : null}
            {last || !item.link ? (
              <span
                className={last ? 'text-foreground' : undefined}
                {...(last ? { 'aria-current': 'page' as const } : {})}
              >
                {item.label}
              </span>
            ) : (
              <Link {...item.link} className="hover:text-foreground">
                {item.label}
              </Link>
            )}
          </Fragment>
        )
      })}
    </nav>
  )
}
