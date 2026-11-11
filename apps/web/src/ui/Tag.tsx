import type { ReactNode } from 'react'

import type { StatusTone } from './colors.ts'

/** A compact status tag: tinted background and border in the tone's color, never color alone. */
export function Tag({
  tone = 'default',
  dot,
  mono,
  title,
  children,
  className = '',
}: {
  tone?: StatusTone
  /** Leading dot in the tone's color. */
  dot?: boolean
  /** Monospace text, for ids, versions and hashes. */
  mono?: boolean
  title?: string
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={`tag ${mono ? 'mono' : ''} ${className}`}
      data-tone={tone}
      {...(title ? { title } : {})}
    >
      {dot ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" /> : null}
      {children}
    </span>
  )
}
