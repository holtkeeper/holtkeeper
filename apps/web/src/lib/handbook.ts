import type {
  Handbook,
  HandbookChapter,
  HandbookEntry,
  HandbookLink,
  KnowledgeFreshnessView,
} from '@holtkeeper/api'

import { type Space } from './guide.ts'
import { repoKey } from './repo.ts'

/** The `GET /api/knowledge/handbook` filters of a Knowledge space: a team or a repository. */
export function handbookQuery(space: Space): { repo?: string; team?: string } {
  if (space.kind === 'team') return { team: space.team }
  if (space.kind === 'repo') return { repo: repoKey(space.repo) }
  return {}
}

/** Whether a stale or suspect entry needs a person's look. */
export const needsAttention = (entry: Pick<HandbookEntry, 'freshness'>): boolean =>
  entry.freshness?.status === 'suspect' || entry.freshness?.status === 'stale'

/** What the handbook list is narrowed by on the client. */
export interface HandbookFilter {
  text?: string
  /** Only suspect and stale entries. */
  attention?: boolean
  /** Repositories of a family (`forge:path`): keeps entries naming one of them or no repository. */
  members?: readonly string[]
}

/** The handbook narrowed by `filter`: empty chapters and links to hidden entries are dropped. */
export function filterHandbook(handbook: Handbook, filter: HandbookFilter): Handbook {
  const words = (filter.text ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const keep = (entry: HandbookEntry) => {
    if (filter.attention && !needsAttention(entry)) return false
    if (
      filter.members &&
      entry.repos.length &&
      !entry.repos.some((r) => filter.members?.includes(r))
    )
      return false
    const haystack = [entry.title, entry.body, ...entry.topics, entry.subject ?? '']
      .join('\n')
      .toLowerCase()
    return words.every((word) => haystack.includes(word))
  }
  const chapters = handbook.chapters.flatMap((chapter): HandbookChapter[] => {
    const entries = chapter.entries.filter(keep)
    return entries.length ? [{ ...chapter, entries }] : []
  })
  const ids = new Set(chapters.flatMap((c) => c.entries.map((e) => e.id)))
  return {
    chapters,
    links: handbook.links.filter((l) => ids.has(l.from) && ids.has(l.to)),
    counts: handbook.counts,
  }
}

/** Words for a link kind, from the entry that has the link (`outgoing`) or the one it points at. */
export function linkKindLabel(kind: HandbookLink['kind'], outgoing: boolean): string {
  switch (kind) {
    case 'supersedes':
      return outgoing ? 'Supersedes' : 'Superseded by'
    case 'cites':
      return outgoing ? 'Cites' : 'Cited by'
    case 'subject':
      return 'Same subject'
    case 'topics':
      return 'Shared topics'
    default:
      return 'Similar'
  }
}

/** An entry related to another one, with how. */
export interface Related {
  id: string
  kind: HandbookLink['kind']
  outgoing: boolean
  weight: number
}

/** The entries linked to `id` (either direction), strongest first; one row per entry and kind. */
export function relatedTo(links: readonly HandbookLink[], id: string): Related[] {
  const seen = new Map<string, Related>()
  for (const link of links) {
    if (link.from !== id && link.to !== id) continue
    const outgoing = link.from === id
    const other = outgoing ? link.to : link.from
    const key = `${other}\0${link.kind}\0${outgoing}`
    const known = seen.get(key)
    if (!known || known.weight < link.weight)
      seen.set(key, { id: other, kind: link.kind, outgoing, weight: link.weight })
  }
  return [...seen.values()].toSorted((a, b) => b.weight - a.weight || a.id.localeCompare(b.id))
}

/** Ids of the entries linked to `id`. */
export const neighbourIds = (links: readonly HandbookLink[], id: string): Set<string> =>
  new Set(relatedTo(links, id).map((r) => r.id))

/** The element id of a chapter in the article, for the table of contents. */
export const chapterAnchor = (key: string): string => `hb-chapter-${key.replace(/[^\w-]+/g, '-')}`

/** The element id of an entry in the article. */
export const entryAnchor = (id: string): string => `hb-entry-${id}`

/** How a freshness check reads, with a tone: fresh is quiet, the others warn. */
export function freshnessLine(
  freshness: KnowledgeFreshnessView,
  now: Date = new Date(),
): { tone: 'default' | 'warning'; text: string } {
  if (freshness.status === 'fresh') {
    const days = Math.max(
      0,
      Math.floor((now.getTime() - new Date(freshness.checkedAt).getTime()) / 86_400_000),
    )
    return {
      tone: 'default',
      text: days === 0 ? 'Checked today' : `Checked ${days} ${days === 1 ? 'day' : 'days'} ago`,
    }
  }
  const label = freshness.status === 'stale' ? 'Stale' : 'May be outdated'
  return { tone: 'warning', text: freshness.reason ? `${label}: ${freshness.reason}` : label }
}

/** The chapters' entries in reading order, flat. */
export const entriesOf = (handbook: Handbook): HandbookEntry[] =>
  handbook.chapters.flatMap((chapter) => chapter.entries)

/** Most entries the relationship graph draws at once; beyond it, it shows one entry's neighbourhood. */
const GRAPH_MAX_NODES = 250

/**
 * The ids the graph draws: every id while there are at most `max`; otherwise the selected entry
 * and its neighbours (an Obsidian-style local graph), or nothing without a selection.
 */
export function graphScope(
  ids: readonly string[],
  links: readonly HandbookLink[],
  selected: string | undefined,
  max = GRAPH_MAX_NODES,
): { ids: string[]; local: boolean } {
  if (ids.length <= max) return { ids: [...ids], local: false }
  if (!selected || !ids.includes(selected)) return { ids: [], local: true }
  const near = neighbourIds(links, selected)
  return { ids: ids.filter((id) => id === selected || near.has(id)).slice(0, max), local: true }
}

/** Simulation steps for `n` nodes: fewer for larger graphs, so a layout stays well under a frame budget. */
export const layoutIterations = (n: number): number =>
  Math.max(40, Math.min(200, Math.round(40_000 / Math.max(1, n))))
