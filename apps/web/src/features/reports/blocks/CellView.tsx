import type { Cell, Column, Tone, Unit } from '@holtkeeper/api'
import { ExternalLink } from 'lucide-react'

import { formatDate } from '../../../lib/format.ts'
import { sparkPaths } from '../../../lib/sparkline.ts'
import { cellText, deltaTone, formatDelta, formatValue, toneColor } from '../../../lib/units.ts'
import { ToneChip } from '../tone.tsx'

const SPARK_WIDTH = 72
const SPARK_HEIGHT = 22

/** A cell's text after a small trend of its `series`, colored by its tone. */
function SparklineCell({
  text,
  series,
  tone,
  unit,
}: {
  text: string
  series: readonly (number | null)[]
  tone: Tone | undefined
  unit: Unit
}) {
  const paths = sparkPaths(series, SPARK_WIDTH, SPARK_HEIGHT)
  const color = tone && tone !== 'neutral' ? toneColor[tone] : 'var(--series-1)'
  const values = series.filter((v) => v !== null)
  const range = values.length
    ? `from ${formatValue(values[0], unit)} to ${formatValue(values.at(-1), unit)}`
    : 'no data'
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg
        width={SPARK_WIDTH}
        height={SPARK_HEIGHT}
        viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
        role="img"
        aria-label={`Trend ${range}`}
        className="shrink-0 overflow-visible"
      >
        <path d={paths.area} fill={color} fillOpacity={0.12} />
        <path
          d={paths.line}
          fill="none"
          stroke={color}
          strokeWidth={1.6}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {paths.last ? (
          <circle
            cx={paths.last.x}
            cy={paths.last.y}
            r={2.2}
            fill={color}
            stroke="var(--surface)"
          />
        ) : null}
      </svg>
      <span
        className="tabular font-medium"
        style={tone && tone !== 'neutral' ? { color } : undefined}
      >
        {text}
      </span>
    </span>
  )
}

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
  if (column.format === 'sparkline' && typeof cell === 'object' && cell.series) {
    const body = <SparklineCell text={text} series={cell.series} tone={cell.tone} unit={unit} />
    return cell.href ? (
      <a href={cell.href} title={cell.hint} className="hover:underline">
        {body}
      </a>
    ) : (
      <span title={cell.hint}>{body}</span>
    )
  }
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
