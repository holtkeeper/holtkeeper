import { ChevronRight } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { otherTeamsText } from '../lib/other-teams.ts'

/**
 * Other teams' items folded away, collapsed by default; renders nothing when `count` is 0. Pass
 * `open` and `onOpenChange` to control it.
 *
 * The `section` variant is a header "Other teams (N)" with the team names and `children` below.
 * The `row` variant goes inside a `tbody`: one row spanning `colSpan` columns that reads
 * "Other teams · 40 repositories of 3 other teams", followed by `children` (more rows) once open.
 */
export function OtherTeams({
  count,
  teams,
  children,
  defaultOpen = false,
  open: controlled,
  onOpenChange,
  variant = 'section',
  colSpan = 1,
  noun,
  summary,
}: {
  count: number
  teams?: readonly string[]
  children: ReactNode
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  variant?: 'section' | 'row'
  /** Columns the `row` variant spans. */
  colSpan?: number
  /** What the items are, for the `row` variant; defaults to repositories. */
  noun?: { one: string; many?: string }
  /** Quiet text after the count in the `row` variant, e.g. "38 healthy · 2 failing". */
  summary?: ReactNode
}) {
  const [own, setOwn] = useState(defaultOpen)
  const open = controlled ?? own
  const setOpen = (next: boolean) => {
    setOwn(next)
    onOpenChange?.(next)
  }
  if (!count) return null
  const chevron = (
    <ChevronRight
      aria-hidden
      className={`size-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
    />
  )
  if (variant === 'row') {
    return (
      <>
        <tr>
          <td colSpan={colSpan} className="border-b border-line p-0">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              className="flex w-full items-center gap-2 px-3.5 py-[11px] text-left text-[12.5px] text-muted hover:bg-raise hover:text-foreground"
            >
              {chevron}
              <span className="font-medium text-foreground">Other teams</span>
              <span aria-hidden className="text-dim">
                ·
              </span>
              <span className="tabular">{otherTeamsText(count, teams?.length ?? 0, noun)}</span>
              {teams?.length ? (
                <span className="min-w-0 truncate text-dim">{teams.join(', ')}</span>
              ) : null}
              {summary ? (
                <>
                  <span aria-hidden className="text-dim">
                    ·
                  </span>
                  <span>{summary}</span>
                </>
              ) : null}
            </button>
          </td>
        </tr>
        {open ? children : null}
      </>
    )
  }
  return (
    <section className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 self-start rounded-md px-1 py-0.5 text-xs text-muted hover:text-foreground"
      >
        {chevron}
        <span>
          Other teams <span className="tabular">({count})</span>
        </span>
        {teams?.length ? <span className="text-muted">· {teams.join(', ')}</span> : null}
      </button>
      {open ? children : null}
    </section>
  )
}
