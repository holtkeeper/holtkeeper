import { reciprocalRankFusion } from '@holtkeeper/embed'
import type { KnowledgeEntry } from '@holtkeeper/store'

/** The `EmbeddingStore` subject of an entry's vector: `knowledge:<id>`. */
export const embeddingSubject = (id: string): string => `knowledge:${id}`

/**
 * The text of an entry that gets embedded: the title, a blank line, the body and, when it has
 * topics, a `Topics: a, b` line. Its `contentHash` changes exactly when one of them does.
 */
export function embeddingText(entry: Pick<KnowledgeEntry, 'title' | 'body' | 'topics'>): string {
  const topics = entry.topics.length ? `\nTopics: ${entry.topics.join(', ')}` : ''
  return `${entry.title.trim()}\n\n${entry.body.trim()}${topics}`
}

/**
 * Relevance by reciprocal rank fusion of a lexical and a semantic ranking: `items` with a lexical
 * score above 0 rank by it (ties: the order given), items with a cosine in `semantic` rank by it;
 * an item missing from a ranking gets nothing from it, so one without a vector ranks last there.
 * Returns item id → fused relevance (0 for items in neither ranking).
 */
export function fusedRelevance(
  items: readonly { id: string; lexical: number }[],
  semantic: ReadonlyMap<string, number>,
): Map<string, number> {
  const lexical = items
    .filter((item) => item.lexical > 0)
    .toSorted((a, b) => b.lexical - a.lexical)
    .map((item) => item.id)
  const vectors = items
    .filter((item) => semantic.has(item.id))
    .toSorted((a, b) => semantic.get(b.id)! - semantic.get(a.id)!)
    .map((item) => item.id)
  const fused = reciprocalRankFusion([lexical, vectors])
  return new Map(items.map((item) => [item.id, fused.get(item.id) ?? 0]))
}
