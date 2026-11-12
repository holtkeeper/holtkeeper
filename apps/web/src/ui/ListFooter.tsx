import type { ReactNode } from 'react'

import { shownText } from '../lib/list-footer.ts'

/**
 * The line under a list: "Showing 10 of 1,284" with an optional caption, then a slot for a
 * `LoadMore` and keyboard hints at the right.
 *
 * @public
 */
export function ListFooter({
  shown,
  total,
  noun,
  caption,
  more,
  hints,
  className = '',
}: {
  shown: number
  total: number
  /** What the list holds, e.g. "jobs". */
  noun?: string
  /** Quiet text after the count, e.g. "· read nightly". */
  caption?: ReactNode
  /** Usually a `LoadMore`, shown while items remain. */
  more?: ReactNode
  /** Keyboard hints, e.g. `<Kbd>J</Kbd>`. */
  hints?: ReactNode
  className?: string
}) {
  return (
    <footer
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-2.5 text-xs text-muted ${className}`}
    >
      <span>
        <span className="tabular">{shownText(shown, total, noun)}</span>
        {caption ? <> {caption}</> : null}
      </span>
      <span className="flex-1" />
      {shown < total && more ? more : null}
      {hints ? <span className="flex items-center gap-1.5">{hints}</span> : null}
    </footer>
  )
}
