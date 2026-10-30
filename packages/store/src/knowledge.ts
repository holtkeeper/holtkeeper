import type {
  KnowledgeContent,
  KnowledgeEntry,
  KnowledgeFilter,
  KnowledgeRevision,
  KnowledgeStore,
} from './types.ts'

const clone = <T>(value: T): T => structuredClone(value)

const asList = <T extends string>(value: T | T[] | undefined): T[] | undefined =>
  value === undefined ? undefined : typeof value === 'string' ? [value] : value

/** Lowercase words of `text`: letters, digits and underscores; everything else separates. */
export const knowledgeWords = (text: string): string[] =>
  text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []

/** Whether `entry` satisfies every field of `filter`. */
export function matchesKnowledgeFilter(entry: KnowledgeEntry, filter: KnowledgeFilter = {}) {
  const statuses = asList(filter.status)
  if (statuses && !statuses.includes(entry.status)) return false
  const kinds = asList(filter.kind)
  if (kinds && !kinds.includes(entry.kind)) return false
  if (filter.topic !== undefined) {
    const topic = filter.topic.toLowerCase()
    if (!entry.topics.some((candidate) => candidate.toLowerCase() === topic)) return false
  }
  if (filter.scope !== undefined) {
    const text = filter.scope.toLowerCase()
    const patterns = [...(entry.scope.groups ?? []).flat(), ...(entry.scope.repos ?? [])]
    const hit =
      (text === 'all' && entry.scope.all === true) ||
      patterns.some((pattern) => pattern.toLowerCase().includes(text))
    if (!hit) return false
  }
  if (filter.package !== undefined) {
    const separator = filter.package.indexOf(':')
    const ecosystem = separator > 0 ? filter.package.slice(0, separator) : undefined
    const name = separator > 0 ? filter.package.slice(separator + 1) : filter.package
    const hit = (entry.packages ?? []).some(
      (pkg) => pkg.name === name && (ecosystem === undefined || pkg.ecosystem === ecosystem),
    )
    if (!hit) return false
  }
  return true
}

function memoryScore(entry: KnowledgeEntry, terms: string[]): number {
  const fields: [weight: number, words: string[]][] = [
    [5, knowledgeWords(entry.title)],
    [
      3,
      knowledgeWords([...entry.topics, ...(entry.packages ?? []).map((pkg) => pkg.name)].join(' ')),
    ],
    [1, knowledgeWords(entry.body)],
  ]
  let score = 0
  for (const term of terms) {
    for (const [weight, words] of fields) {
      const hits = words.filter((word) => word.startsWith(term)).length
      if (hits) score += (weight * hits) / (hits + 1)
    }
  }
  return score
}

const content = (entry: KnowledgeEntry): KnowledgeContent => ({
  title: entry.title,
  body: entry.body,
  kind: entry.kind,
  scope: entry.scope,
  topics: entry.topics,
  appliesTo: entry.appliesTo,
  ...(entry.packages !== undefined && { packages: entry.packages }),
  status: entry.status,
  evidence: entry.evidence,
  ...(entry.supersedes !== undefined && { supersedes: entry.supersedes }),
})

/** The in-memory `KnowledgeStore`; search scores entries by weighted prefix matches of words. */
export function memoryKnowledge(): KnowledgeStore {
  const entries = new Map<string, KnowledgeEntry>()
  const order = new Map<string, number>()
  const histories = new Map<string, KnowledgeRevision[]>()
  let seq = 0

  const sorted = () =>
    [...entries.values()].toSorted(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0),
    )

  return {
    async put(input) {
      const previous = entries.get(input.id)
      if (previous) {
        const revision: KnowledgeRevision = {
          ...clone(content(previous)),
          version: previous.version,
          editedBy: previous.updatedBy ?? previous.author,
          editedAt: previous.updatedAt,
        }
        histories.set(input.id, [revision, ...(histories.get(input.id) ?? [])])
      }
      const stored: KnowledgeEntry = { ...clone(input), version: (previous?.version ?? 0) + 1 }
      entries.set(stored.id, stored)
      order.set(stored.id, seq++)
      return clone(stored)
    },
    get: async (id) => clone(entries.get(id)),
    history: async (id) => clone(histories.get(id) ?? []),
    list: async (filter) =>
      sorted()
        .filter((entry) => matchesKnowledgeFilter(entry, filter))
        .map(clone),
    async remove(id) {
      entries.delete(id)
      histories.delete(id)
    },
    async search(text, filter, limit = 20) {
      const terms = [...new Set(knowledgeWords(text))]
      if (!terms.length) return []
      return sorted()
        .filter((entry) => matchesKnowledgeFilter(entry, filter))
        .map((entry) => ({ entry, score: memoryScore(entry, terms) }))
        .filter((hit) => hit.score > 0)
        .toSorted((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((hit) => ({ entry: clone(hit.entry), score: hit.score }))
    },
  }
}
