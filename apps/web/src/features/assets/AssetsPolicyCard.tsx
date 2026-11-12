import type { ReactNode } from 'react'

import { LinkButton } from '../../ui/index.ts'

/**
 * The asset policy as a card: where it comes from, the labelled lines agents read, a link to the
 * prose rules in the Guide (`space`) and, below, `children` such as the policy's own entries.
 */
export function AssetsPolicyCard({
  lines,
  source,
  space,
  actions,
  children,
}: {
  lines: readonly { label: string; value: string }[]
  source: ReactNode
  /** Guide space key of the prose rules, e.g. `all` or `repo:forge:path`. */
  space: string
  actions?: ReactNode
  children?: ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2.5">
        <h2 className="text-[13px] font-semibold">Asset policy</h2>
        <span className="text-xs text-muted">{source}</span>
        <span className="flex-1" />
        <LinkButton to="/knowledge/guide" search={{ space }} variant="ghost" size="sm">
          Prose rules in the Guide
        </LinkButton>
        {actions}
      </div>
      <dl className="m-0 grid grid-cols-2 gap-x-[18px] gap-y-2.5 px-3.5 py-3 text-xs md:grid-cols-4">
        {lines.map((line) => (
          <div key={line.label} className="min-w-0">
            <dt className="text-[11.5px] text-muted">{line.label}</dt>
            <dd className="mono m-0 mt-0.5 break-words">{line.value}</dd>
          </div>
        ))}
      </dl>
      {children ? <div className="px-3.5 pb-3">{children}</div> : null}
    </section>
  )
}
