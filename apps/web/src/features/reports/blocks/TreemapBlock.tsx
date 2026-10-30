import type { Block } from '@holtkeeper/api'
import { ChevronRight, Home } from 'lucide-react'
import { useMemo, useState } from 'react'
import { ResponsiveContainer, Tooltip, Treemap, type TreemapNode } from 'recharts'

import { nodeAt, sizeTree, visibleChildren } from '../../../lib/tree.ts'
import { formatValue, toneColor } from '../../../lib/units.ts'
import { seriesColor } from '../tone.tsx'

/** Sizes as nested rectangles; clicking a rectangle with children drills into it. */
export function TreemapBlock({ block }: { block: Extract<Block, { type: 'treemap' }> }) {
  const unit = block.unit ?? 'bytes'
  const root = useMemo(() => sizeTree(block.root), [block.root])
  const [path, setPath] = useState<string[]>([])
  const { node, path: walked } = nodeAt(root, path)
  const children = visibleChildren(node)
  const items = children.map((child, index) => ({
    name: child.name,
    value: child.value,
    color: child.tone ? toneColor[child.tone] : seriesColor(index),
    drillable: Boolean(child.children?.length),
  }))
  const byName = new Map(items.map((item) => [item.name, item]))
  const drill = (name: string) => {
    if (byName.get(name)?.drillable) setPath([...walked, name])
  }

  const renderCell = (cell: TreemapNode) => {
    const item = byName.get(cell.name)
    if (!item || cell.depth !== 1) return <g />
    const showLabel = cell.width > 56 && cell.height > 28
    return (
      <g className={item.drillable ? 'cursor-pointer' : undefined}>
        <rect
          x={cell.x}
          y={cell.y}
          width={cell.width}
          height={cell.height}
          rx={6}
          fill={item.color}
          fillOpacity={0.82}
          stroke="var(--surface)"
          strokeWidth={2}
        />
        {showLabel ? (
          <>
            <text x={cell.x + 8} y={cell.y + 18} fill="white" fontSize={12} fontWeight={600}>
              {cell.name.length > cell.width / 7
                ? `${cell.name.slice(0, Math.max(3, Math.floor(cell.width / 7) - 1))}…`
                : cell.name}
            </text>
            {cell.height > 44 ? (
              <text x={cell.x + 8} y={cell.y + 34} fill="white" fillOpacity={0.85} fontSize={11}>
                {formatValue(item.value, unit)}
              </text>
            ) : null}
          </>
        ) : null}
      </g>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <nav aria-label="Treemap path" className="flex flex-wrap items-center gap-1 text-sm">
        <button
          type="button"
          onClick={() => setPath([])}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-default focus-visible:outline-2 focus-visible:outline-focus"
        >
          <Home className="size-3.5" />
          {root.name}
        </button>
        {walked.map((name, index) => (
          <span key={`${name}-${index}`} className="inline-flex items-center gap-1">
            <ChevronRight className="size-3.5 text-muted" />
            <button
              type="button"
              onClick={() => setPath(walked.slice(0, index + 1))}
              aria-current={index === walked.length - 1 ? 'location' : undefined}
              className="rounded-md px-1.5 py-0.5 hover:bg-default focus-visible:outline-2 focus-visible:outline-focus"
            >
              {name}
            </button>
          </span>
        ))}
        <span className="ml-auto text-xs text-muted tabular">{formatValue(node.value, unit)}</span>
      </nav>
      {items.length ? (
        <div className="h-80 w-full" aria-hidden>
          <ResponsiveContainer width="100%" height="100%">
            <Treemap
              data={items}
              dataKey="value"
              nameKey="name"
              aspectRatio={4 / 3}
              isAnimationActive
              animationDuration={400}
              content={renderCell}
              onClick={(cell) => drill(cell.name)}
            >
              <Tooltip
                content={({ active, payload }) => {
                  const item = byName.get(String(payload?.[0]?.name ?? ''))
                  if (!active || !item) return null
                  return (
                    <div className="rounded-lg border border-border bg-overlay px-2.5 py-1.5 text-xs shadow-overlay">
                      <div className="font-medium">{item.name}</div>
                      <div className="tabular text-muted">
                        {formatValue(item.value, unit)}
                        {node.value ? ` · ${Math.round((item.value / node.value) * 100)}%` : ''}
                        {item.drillable ? ' · click to open' : ''}
                      </div>
                    </div>
                  )
                }}
              />
            </Treemap>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="text-sm text-muted">Nothing inside {node.name}.</p>
      )}
      <ul
        className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3"
        aria-label={`Contents of ${node.name}`}
      >
        {items.slice(0, 12).map((item) => (
          <li key={item.name} className="flex items-center justify-between gap-2">
            {item.drillable ? (
              <button
                type="button"
                onClick={() => drill(item.name)}
                className="flex min-w-0 items-center gap-2 rounded text-left hover:underline focus-visible:outline-2 focus-visible:outline-focus"
              >
                <span className="size-2 shrink-0 rounded-full" style={{ background: item.color }} />
                <span className="truncate">{item.name}</span>
                <ChevronRight className="size-3 shrink-0 text-muted" />
              </button>
            ) : (
              <span className="flex min-w-0 items-center gap-2">
                <span className="size-2 shrink-0 rounded-full" style={{ background: item.color }} />
                <span className="truncate">{item.name}</span>
              </span>
            )}
            <span className="tabular shrink-0 text-xs text-muted">
              {formatValue(item.value, unit)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
