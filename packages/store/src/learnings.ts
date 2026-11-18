import { prefixScore, searchWords } from './search.ts'
import type {
  Learning,
  LearningFilter,
  LearningStore,
  ReactionSignal,
  ReactionTotals,
} from './types.ts'

const clone = <T>(value: T): T => structuredClone(value)

/** Whether `learning` passes every field of `filter`. */
export const matchesLearningFilter = (learning: Learning, filter: LearningFilter = {}) =>
  (!filter.status || filter.status.includes(learning.status)) &&
  (!filter.origin || filter.origin.includes(learning.origin))

const binary = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Newest `updatedAt` first, then by id. */
export const byLearningUpdate = (a: Learning, b: Learning) =>
  binary(b.updatedAt, a.updatedAt) || binary(a.id, b.id)

/** Sums `signals` per category, sorted by category; `repos` keeps only those repositories. */
export function sumReactions(
  signals: Iterable<ReactionSignal>,
  repos?: readonly string[],
): ReactionTotals[] {
  const totals = new Map<string, ReactionTotals>()
  for (const signal of signals) {
    if (repos && !repos.includes(signal.repo)) continue
    const total = totals.get(signal.category) ?? {
      category: signal.category,
      comments: 0,
      up: 0,
      down: 0,
    }
    total.comments++
    total.up += signal.up
    total.down += signal.down
    totals.set(signal.category, total)
  }
  return [...totals.values()].toSorted((a, b) => binary(a.category, b.category))
}

/**
 * Signals of `filter.repo` (of every repository without it), only those of `filter.mergeRequests`
 * when given, sorted by repository, merge request and note.
 */
export function reactionsOf(
  signals: Iterable<ReactionSignal>,
  filter: { repo?: string; mergeRequests?: readonly number[] } = {},
): ReactionSignal[] {
  return [...signals]
    .filter(
      (signal) =>
        (filter.repo === undefined || signal.repo === filter.repo) &&
        (!filter.mergeRequests || filter.mergeRequests.includes(signal.mergeRequest)),
    )
    .toSorted(
      (a, b) =>
        binary(a.repo, b.repo) || a.mergeRequest - b.mergeRequest || binary(a.noteId, b.noteId),
    )
}

/** The key reaction counts are stored under. */
export const reactionKey = (signal: Pick<ReactionSignal, 'repo' | 'mergeRequest' | 'noteId'>) =>
  `${signal.repo}\u0000${signal.mergeRequest}\u0000${signal.noteId}`

/** The in-memory `LearningStore`; search scores learnings by prefix matches of their words. */
export function memoryLearnings(): LearningStore {
  const learnings = new Map<string, Learning>()
  const claims = new Map<string, string>()
  const reactions = new Map<string, ReactionSignal>()
  const listed = (filter?: LearningFilter) =>
    [...learnings.values()]
      .filter((learning) => matchesLearningFilter(learning, filter))
      .toSorted(byLearningUpdate)
  return {
    get: async (id) => clone(learnings.get(id)),
    list: async (filter) => listed(filter).map(clone),
    find: async (key) =>
      clone(
        [...learnings.values()]
          .filter((learning) => learning.key === key)
          .toSorted((a, b) => binary(a.createdAt, b.createdAt) || binary(a.id, b.id))[0],
      ),
    async put(learning) {
      learnings.set(learning.id, clone(learning))
    },
    async remove(id) {
      learnings.delete(id)
    },
    async search(text, filter, limit = 20) {
      const terms = [...new Set(searchWords(text))]
      if (!terms.length) return []
      return listed(filter)
        .map((learning) => ({ learning, score: prefixScore(terms, [[1, learning.text]]) }))
        .filter((hit) => hit.score > 0)
        .toSorted((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((hit) => ({ learning: clone(hit.learning), score: hit.score }))
    },
    async claim(key, at) {
      if (claims.has(key)) return false
      claims.set(key, at)
      return true
    },
    async release(key) {
      claims.delete(key)
    },
    async putReactions(signal) {
      reactions.set(reactionKey(signal), clone(signal))
    },
    reactionTotals: async (filter) => sumReactions(reactions.values(), filter?.repos),
    reactions: async (filter) => reactionsOf(reactions.values(), filter).map(clone),
  }
}
