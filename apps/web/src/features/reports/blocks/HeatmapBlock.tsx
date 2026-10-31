import type { Block } from '@holtkeeper/api'
import { useState } from 'react'

import { heatLimit, heatOf, labelStep } from '../../../lib/heatmap.ts'
import { formatValue, toneColor } from '../../../lib/units.ts'
import { tableScrollClass } from '../../../ui/index.ts'

type HeatmapBlockData = Extract<Block, { type: 'heatmap' }>

const cellBackground = (tone: keyof typeof toneColor, strength: number) =>
  strength === 0
    ? 'var(--chart-grid)'
    : `color-mix(in oklab, ${toneColor[tone]} ${Math.round(12 + strength * 78)}%, transparent)`

function ScaleLegend({ block, limit }: { block: HeatmapBlockData; limit: number }) {
  const unit = block.unit ?? 'count'
  if (block.scale.kind === 'sequential') {
    const color = toneColor[block.scale.tone]
    return (
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className="tabular">{formatValue(0, unit)}</span>
        <span
          className="h-2 w-28 rounded-full"
          style={{ background: `linear-gradient(90deg, var(--chart-grid), ${color})` }}
        />
        <span className="tabular">{formatValue(limit, unit)}</span>
      </div>
    )
  }
  const better = block.scale.better
  const low = toneColor[better === 'up' ? 'bad' : 'good']
  const high = toneColor[better === 'up' ? 'good' : 'bad']
  return (
    <div className="flex items-center gap-2 text-xs text-muted">
      <span className="tabular">−{formatValue(limit, unit)}</span>
      <span
        className="h-2 w-36 rounded-full"
        style={{ background: `linear-gradient(90deg, ${low}, var(--chart-grid) 50%, ${high})` }}
      />
      <span className="tabular">+{formatValue(limit, unit)}</span>
    </div>
  )
}

/** Rows by columns of colored cells, e.g. jobs by week; hovering a cell shows its value. */
export function HeatmapBlock({ block }: { block: HeatmapBlockData }) {
  const unit = block.unit ?? 'count'
  const limit = heatLimit(block)
  const step = labelStep(block.xLabels.length)
  const [hover, setHover] = useState<{ row: string; column: string; text: string }>()

  if (!block.yRows.length) return <p className="text-sm text-muted">No data.</p>

  return (
    <div className="flex flex-col gap-3">
      <div className={tableScrollClass}>
        <table className="border-separate border-spacing-[3px] text-xs" aria-label={block.title}>
          <thead>
            <tr>
              <th scope="col" className="sr-only">
                Row
              </th>
              {block.xLabels.map((label, index) => (
                <th
                  key={`${label}:${index}`}
                  scope="col"
                  className="sticky top-0 z-20 h-5 min-w-5 bg-surface px-0 text-left align-bottom font-normal whitespace-nowrap text-muted"
                >
                  <span className={index % step === 0 ? '' : 'sr-only'}>{label}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody onMouseLeave={() => setHover(undefined)}>
            {block.yRows.map((row) => (
              <tr key={row.label}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 max-w-48 bg-surface pr-3 text-left font-mono text-[12px] font-normal"
                >
                  {row.href ? (
                    <a
                      href={row.href}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate hover:text-accent hover:underline"
                      title={row.label}
                    >
                      {row.label}
                    </a>
                  ) : (
                    <span className="block truncate" title={row.label}>
                      {row.label}
                    </span>
                  )}
                </th>
                {block.xLabels.map((column, index) => {
                  const cell = row.cells[index]
                  const text = cell ? (cell.text ?? formatValue(cell.value, unit)) : 'no runs'
                  const heat = cell ? heatOf(cell.value, block.scale, limit) : undefined
                  return (
                    <td
                      key={`${column}:${index}`}
                      aria-label={`${row.label}, ${column}: ${text}`}
                      onMouseEnter={() => setHover({ row: row.label, column, text })}
                      className="h-6 min-w-5 rounded-[5px] p-0 transition-transform duration-150 hover:scale-125 hover:shadow-overlay"
                      style={{
                        background: heat ? cellBackground(heat.tone, heat.strength) : 'transparent',
                        ...(heat
                          ? {}
                          : { outline: '1px dashed var(--chart-grid)', outlineOffset: -1 }),
                      }}
                    />
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-h-5 text-xs" aria-live="polite">
          {hover ? (
            <span>
              <span className="font-mono">{hover.row}</span>
              <span className="text-muted"> · {hover.column} · </span>
              <span className="tabular font-medium">{hover.text}</span>
            </span>
          ) : (
            <span className="text-muted">Hover a cell for its value.</span>
          )}
        </div>
        <ScaleLegend block={block} limit={limit} />
      </div>
    </div>
  )
}
