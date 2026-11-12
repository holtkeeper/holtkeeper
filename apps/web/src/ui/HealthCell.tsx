import { Link, type LinkProps } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { Dot, type DotTone } from './Legend.tsx'

/**
 * A health figure in a table cell: status dot and value, with a quiet caption under it. With
 * `link` the whole cell opens that page. `status` names the tone for screen readers, since the
 * dot alone carries no meaning.
 *
 * @public
 */
export function HealthCell({
  tone,
  value,
  caption,
  status,
  mono,
  link,
}: {
  tone: DotTone
  value: ReactNode
  caption?: ReactNode
  /** Hidden text naming the state, e.g. "failing". */
  status?: string
  /** Monospace value, for scores, sizes and versions. */
  mono?: boolean
  link?: LinkProps
}) {
  const body = (
    <>
      <span className="inline-flex items-center gap-1.5">
        <Dot tone={tone} />
        <span className={`group-hover:underline ${mono ? 'mono' : ''}`}>{value}</span>
        {status ? <span className="sr-only">, {status}</span> : null}
      </span>
      {caption ? <span className="ps-3 text-[11px] text-dim">{caption}</span> : null}
    </>
  )
  const className = 'group flex min-w-[72px] flex-col gap-0.5 leading-tight text-foreground'
  return link ? (
    <Link {...link} className={`${className} no-underline`}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  )
}
