import type { Cell, Column } from '@holtkeeper/api'
import { ExternalLink } from 'lucide-react'

import { formatDate } from '../../../lib/format.ts'
import { cellText, deltaTone, formatDelta, toneColor } from '../../../lib/units.ts'
import { ToneChip } from '../tone.tsx'

/** One table cell rendered by its column's unit and format. */
export function CellView({ cell, column }: { cell: Cell | undefined; column: Column }) {
  if (cell === null || cell === undefined || cell === '')
    return <span className="text-muted">—</span>
  const unit = column.unit ?? 'count'

  if (column.format === 'delta' && typeof cell === 'number') {
    const tone = deltaTone(cell, column.better)
    return (
      <span
        className="tabular font-medium"
        style={{ color: tone === 'neutral' ? 'var(--muted)' : toneColor[tone] }}
      >
        {formatDelta(cell, unit)}
      </span>
    )
  }

  const text = cellText(cell, unit)
  if (column.format === 'tags') {
    return (
      <span className="flex flex-wrap gap-1">
        {text
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean)
          .map((tag) => (
            <span key={tag} className="rounded-md bg-default px-1.5 py-0.5 text-[11px]">
              {tag}
            </span>
          ))}
      </span>
    )
  }

  const display =
    column.format === 'date' && !Number.isNaN(Date.parse(text)) ? formatDate(text) : text
  const mono = column.format === 'code' || unit === 'version'
  const content = <span className={mono ? 'font-mono text-[12px]' : undefined}>{display}</span>

  if (typeof cell === 'object') {
    const body = cell.tone ? <ToneChip tone={cell.tone}>{content}</ToneChip> : content
    if (cell.href) {
      const external = /^https?:/i.test(cell.href)
      return (
        <a
          href={cell.href}
          {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
          title={cell.hint}
          className="inline-flex items-center gap-1 text-accent hover:underline focus-visible:outline-2 focus-visible:outline-focus"
        >
          {body}
          {external ? <ExternalLink className="size-3 shrink-0" /> : null}
        </a>
      )
    }
    return <span title={cell.hint}>{body}</span>
  }
  return content
}
