import type { HandbookChapter, HandbookLink } from '@holtkeeper/api'
import { useMemo, useState } from 'react'

import { layoutGraph } from '../../lib/graph-layout.ts'
import {
  graphScope,
  layoutIterations,
  linkKindLabel,
  needsAttention,
  neighbourIds,
} from '../../lib/handbook.ts'
import { statusColor } from '../../ui/colors.ts'

const WIDTH = 760
const HEIGHT = 340

/** Stroke style per link kind: strong relations solid, loose ones dashed and faint. */
const edgeStyle: Record<HandbookLink['kind'], { dash?: string; opacity: number }> = {
  supersedes: { opacity: 0.95 },
  cites: { opacity: 0.7 },
  subject: { dash: '2 3', opacity: 0.5 },
  topics: { dash: '5 4', opacity: 0.4 },
  similar: { dash: '1 4', opacity: 0.35 },
}

const chapterColor = (index: number) => `hsl(${(index * 67) % 360} 55% 55%)`

/**
 * The relationship graph of the handbook's entries: nodes coloured by chapter, suspect and stale
 * ones outlined in the warning colour, edges styled by link kind. Hover names an entry, a click
 * selects it (and the article scrolls to it); the selected entry's neighbours stay lit.
 * `chapters` and `links` are the whole handbook, so the layout does not move while the article is
 * filtered; entries outside `visible` are dimmed. Past `GRAPH_MAX_NODES` it draws only the
 * selected entry and its neighbours.
 */
export function HandbookGraph({
  chapters,
  links,
  visible,
  selected,
  onSelect,
}: {
  chapters: readonly HandbookChapter[]
  links: readonly HandbookLink[]
  visible: ReadonlySet<string>
  selected: string | undefined
  onSelect: (id: string) => void
}) {
  const [hover, setHover] = useState<string>()
  const all = useMemo(
    () =>
      chapters.flatMap((chapter, index) =>
        chapter.entries.map((entry) => ({
          id: entry.id,
          title: entry.title,
          chapter: chapter.title,
          color: chapterColor(index),
          warn: needsAttention(entry),
        })),
      ),
    [chapters],
  )
  const scope = useMemo(
    () =>
      graphScope(
        all.map((node) => node.id),
        links,
        selected,
      ),
    [all, links, selected],
  )
  const nodes = useMemo(() => {
    const drawn = new Set(scope.ids)
    return all.filter((node) => drawn.has(node.id))
  }, [all, scope])
  const layout = useMemo(
    () =>
      layoutGraph(
        nodes.map((n) => n.id),
        links,
        { width: WIDTH, height: HEIGHT, iterations: layoutIterations(nodes.length) },
      ),
    [nodes, links],
  )
  const lit = useMemo(
    () => (selected ? neighbourIds(links, selected) : new Set<string>()),
    [links, selected],
  )
  const hovered = nodes.find((n) => n.id === hover)
  const dim = (id: string) =>
    !visible.has(id) || (Boolean(selected) && id !== selected && !lit.has(id))

  if (scope.local && !nodes.length)
    return (
      <p className="text-muted">
        {all.length} entries are too many to draw at once. Select an entry in the article to see its
        neighbourhood.
      </p>
    )

  return (
    <div className="flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label="Relationships between handbook entries"
        className="h-auto w-full rounded-lg border border-line bg-sunk"
      >
        {links.map((link, i) => {
          const a = layout.get(link.from)
          const b = layout.get(link.to)
          if (!a || !b) return null
          const style = edgeStyle[link.kind]
          const touches = link.from === selected || link.to === selected
          return (
            <line
              key={i}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={touches ? statusColor.accent : 'var(--fg-muted)'}
              strokeWidth={touches ? 1.8 : 1}
              strokeDasharray={style.dash}
              opacity={selected && !touches ? style.opacity * 0.3 : style.opacity}
            >
              <title>{linkKindLabel(link.kind, true)}</title>
            </line>
          )
        })}
        {nodes.map((node) => {
          const p = layout.get(node.id)
          if (!p) return null
          const active = node.id === selected
          return (
            <circle
              key={node.id}
              cx={p.x}
              cy={p.y}
              r={active ? 9 : 6.5}
              fill={node.color}
              stroke={node.warn ? statusColor.warning : active ? statusColor.accent : 'var(--bg)'}
              strokeWidth={node.warn || active ? 2.5 : 1}
              opacity={dim(node.id) ? 0.3 : 1}
              tabIndex={0}
              role="button"
              aria-label={`${node.title} (${node.chapter})`}
              className="cursor-pointer outline-none focus-visible:stroke-[3]"
              onMouseEnter={() => setHover(node.id)}
              onMouseLeave={() => setHover(undefined)}
              onFocus={() => setHover(node.id)}
              onBlur={() => setHover(undefined)}
              onClick={() => onSelect(node.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelect(node.id)
                }
              }}
            >
              <title>{node.title}</title>
            </circle>
          )
        })}
      </svg>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span className="min-h-4 font-medium text-foreground">
          {hovered ? `${hovered.title} · ${hovered.chapter}` : ' '}
        </span>
        <span className="flex-1" />
        {chapters.map((chapter, index) => (
          <span key={chapter.key} className="inline-flex items-center gap-1">
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={{ background: chapterColor(index) }}
            />
            {chapter.title}
          </span>
        ))}
        <span className="inline-flex items-center gap-1">
          <span
            aria-hidden
            className="size-2 rounded-full border-2"
            style={{ borderColor: statusColor.warning }}
          />
          needs attention
        </span>
      </div>
    </div>
  )
}
