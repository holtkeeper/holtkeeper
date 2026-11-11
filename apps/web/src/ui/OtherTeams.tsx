import { ChevronRight } from 'lucide-react'
import { type ReactNode, useState } from 'react'

/**
 * A section folding other teams' items, collapsed by default: a header "Other teams (N)" with the
 * team names, and `children` once opened. Renders nothing when `count` is 0. Pass `open` and
 * `onOpenChange` to control it.
 */
export function OtherTeams({
  count,
  teams,
  children,
  defaultOpen = false,
  open: controlled,
  onOpenChange,
}: {
  count: number
  teams?: readonly string[]
  children: ReactNode
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const [own, setOwn] = useState(defaultOpen)
  const open = controlled ?? own
  const setOpen = (next: boolean) => {
    setOwn(next)
    onOpenChange?.(next)
  }
  if (!count) return null
  return (
    <section className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 self-start rounded-md px-1 py-0.5 text-xs text-muted hover:text-foreground"
      >
        <ChevronRight className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span>
          Other teams <span className="tabular">({count})</span>
        </span>
        {teams?.length ? <span className="text-muted">· {teams.join(', ')}</span> : null}
      </button>
      {open ? children : null}
    </section>
  )
}
