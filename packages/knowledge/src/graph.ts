import { cosine } from '@holtkeeper/embed'
import type { KnowledgeEntry } from '@holtkeeper/store'

/** Why two entries are linked. */
export const linkKinds = ['supersedes', 'cites', 'subject', 'topics', 'similar'] as const

export type LinkKind = (typeof linkKinds)[number]

/** A link between two entries; `from` and `to` are entry ids, `weight` is 0–1. */
export interface KnowledgeLinkEdge {
  from: string
  to: string
  kind: LinkKind
  weight: number
}

/** Cosine from which two entries count as `similar`. */
export const SIMILAR_FROM = 0.8

/** Most `similar` links an entry gets. */
export const SIMILAR_PER_ENTRY = 3

/** Shared topics from which two entries are linked by `topics`. */
export const SHARED_TOPICS = 2

// Entry ids are UUIDs; a citation may give the whole id or a unique prefix of it.
const citeRef = /\[(?:kb:|\[)([0-9a-f][0-9a-f-]{5,})\]?\]/gi

/**
 * The links between `entries`, derived and never stored: an entry that `supersedes` another; a
 * body that cites another as `[kb:<id>]` (a unique id prefix of six or more characters is enough);
 * the same `subject`; at least `SHARED_TOPICS` shared topics; and, with `vectors` (id → vector),
 * the closest vectors (cosine ≥ `SIMILAR_FROM`, at most `SIMILAR_PER_ENTRY` per entry). Each pair
 * has at most one link, the strongest kind first in `linkKinds` order. Deterministic: sorted by
 * `from`, `to`.
 */
export function knowledgeLinks(
  entries: readonly KnowledgeEntry[],
  vectors?: ReadonlyMap<string, Float32Array>,
): KnowledgeLinkEdge[] {
  const ids = new Set(entries.map((entry) => entry.id))
  const byPrefix = (prefix: string) => {
    const hits = entries.filter((entry) => entry.id.startsWith(prefix.toLowerCase()))
    return hits.length === 1 ? hits[0] : undefined
  }
  const found = new Map<string, KnowledgeLinkEdge>()
  const add = (a: string, b: string, kind: LinkKind, weight: number) => {
    if (a === b) return
    const [from, to] = kind === 'supersedes' || kind === 'cites' ? [a, b] : [a, b].toSorted()
    if (!from || !to) return
    const key = [from, to].toSorted().join('\u0000')
    const known = found.get(key)
    if (known && linkKinds.indexOf(known.kind) <= linkKinds.indexOf(kind)) return
    found.set(key, { from, to, kind, weight })
  }

  for (const entry of entries) {
    if (entry.supersedes && ids.has(entry.supersedes))
      add(entry.id, entry.supersedes, 'supersedes', 1)
    for (const match of entry.body.matchAll(citeRef)) {
      const target = match[1] ? byPrefix(match[1]) : undefined
      if (target) add(entry.id, target.id, 'cites', 0.9)
    }
  }
  const bySubject = new Map<string, KnowledgeEntry[]>()
  for (const entry of entries)
    if (entry.subject)
      bySubject.set(entry.subject, [...(bySubject.get(entry.subject) ?? []), entry])
  for (const group of bySubject.values())
    for (const [index, a] of group.entries())
      for (const b of group.slice(index + 1)) add(a.id, b.id, 'subject', 0.7)

  for (const [index, a] of entries.entries())
    for (const b of entries.slice(index + 1)) {
      const shared = a.topics.filter((topic) => b.topics.includes(topic)).length
      if (shared >= SHARED_TOPICS) add(a.id, b.id, 'topics', Math.min(0.6, 0.3 + shared * 0.1))
    }

  if (vectors) {
    for (const a of entries) {
      const va = vectors.get(a.id)
      if (!va) continue
      const closest = entries
        .flatMap((b) => {
          const vb = vectors.get(b.id)
          return b.id === a.id || !vb ? [] : [{ id: b.id, score: cosine(va, vb) }]
        })
        .filter((hit) => hit.score >= SIMILAR_FROM)
        .toSorted((x, y) => y.score - x.score || x.id.localeCompare(y.id))
        .slice(0, SIMILAR_PER_ENTRY)
      for (const hit of closest) add(a.id, hit.id, 'similar', Math.round(hit.score * 100) / 100)
    }
  }
  return [...found.values()].toSorted(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  )
}

/** Entry id → ids of the entries it is linked with, both directions. */
export function linkIndex(edges: readonly KnowledgeLinkEdge[]): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const edge of edges) {
    index.set(edge.from, [...(index.get(edge.from) ?? []), edge.to])
    index.set(edge.to, [...(index.get(edge.to) ?? []), edge.from])
  }
  return index
}

/** A chapter of the handbook: entries about one subject, topic or kind. */
export interface KnowledgeChapter {
  /** Stable key: `subject:<subject>`, `topic:<topic>` or `kind:<kind>`. */
  key: string
  title: string
  ids: string[]
}

const kindTitles: Record<string, string> = {
  decision: 'Decisions',
  convention: 'Conventions',
  migration: 'Migrations',
  quirk: 'Quirks',
  howto: 'How-tos',
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

const subjectTitle = (subject: string): string => {
  const [ecosystem, ...name] = subject.split(':')
  return name.length ? `${name.join(':')} (${ecosystem})` : subject
}

const chapterTitle = (key: string): string => {
  const [type, ...rest] = key.split(':')
  const value = rest.join(':')
  return type === 'subject'
    ? subjectTitle(value)
    : type === 'topic'
      ? capitalize(value)
      : (kindTitles[value] ?? capitalize(value))
}

/**
 * Sorts entries into chapters without anyone naming them. An entry about a `subject` goes to that
 * subject's chapter; others go to the chapter of their most common topic (the topic shared with
 * the most entries, ties alphabetical) when at least `minSize` entries share it; the rest go
 * to the chapter of their kind. A subject or topic chapter smaller than `minSize` is folded into the
 * chapter of its kind. Chapters are ordered by size then title, ids by title; the same
 * entries always give the same chapters, so the page does not reshuffle between runs.
 */
export function knowledgeChapters(
  entries: readonly KnowledgeEntry[],
  minSize = 2,
): KnowledgeChapter[] {
  const topicCount = new Map<string, number>()
  for (const entry of entries)
    for (const topic of new Set(entry.topics))
      topicCount.set(topic, (topicCount.get(topic) ?? 0) + 1)
  const keyOf = (entry: KnowledgeEntry): string => {
    if (entry.subject) return `subject:${entry.subject}`
    const topic = entry.topics
      .filter((candidate) => (topicCount.get(candidate) ?? 0) >= minSize)
      .toSorted(
        (a, b) => (topicCount.get(b) ?? 0) - (topicCount.get(a) ?? 0) || a.localeCompare(b),
      )[0]
    return topic ? `topic:${topic}` : `kind:${entry.kind}`
  }
  const groups = new Map<string, KnowledgeEntry[]>()
  for (const entry of entries)
    groups.set(keyOf(entry), [...(groups.get(keyOf(entry)) ?? []), entry])

  // Small subject and topic chapters fold into their kind's chapter.
  for (const [key, group] of groups) {
    if (key.startsWith('kind:') || group.length >= minSize) continue
    groups.delete(key)
    for (const entry of group) {
      const target = `kind:${entry.kind}`
      groups.set(target, [...(groups.get(target) ?? []), entry])
    }
  }
  const titles = new Map(entries.map((entry) => [entry.id, entry.title.toLowerCase()]))
  return [...groups]
    .map(([key, group]) => ({
      key,
      title: chapterTitle(key),
      ids: group
        .map((entry) => entry.id)
        .toSorted(
          (a, b) => (titles.get(a) ?? '').localeCompare(titles.get(b) ?? '') || a.localeCompare(b),
        ),
    }))
    .toSorted((a, b) => b.ids.length - a.ids.length || a.title.localeCompare(b.title))
}
