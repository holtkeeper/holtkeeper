import type {
  LearningCandidate,
  LearningFilter,
  LearningStore,
  ReactionSignal,
  ReactionTotals,
} from './types.ts'

const clone = <T>(value: T): T => structuredClone(value)

/** Whether `candidate` passes every field of `filter`. */
export const matchesLearningFilter = (candidate: LearningCandidate, filter: LearningFilter = {}) =>
  (!filter.repos || filter.repos.includes(candidate.repo)) &&
  (!filter.status || filter.status.includes(candidate.status))

const binary = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Newest `updatedAt` first, then by id. */
export const byLearningUpdate = (a: LearningCandidate, b: LearningCandidate) =>
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

/** Signals of `filter.repo`, only those of `filter.mergeRequests` when given, sorted by key. */
export function reactionsOf(
  signals: Iterable<ReactionSignal>,
  filter: { repo: string; mergeRequests?: readonly number[] },
): ReactionSignal[] {
  return [...signals]
    .filter(
      (signal) =>
        signal.repo === filter.repo &&
        (!filter.mergeRequests || filter.mergeRequests.includes(signal.mergeRequest)),
    )
    .toSorted((a, b) => a.mergeRequest - b.mergeRequest || binary(a.noteId, b.noteId))
}

/** The key reaction counts are stored under. */
export const reactionKey = (signal: Pick<ReactionSignal, 'repo' | 'mergeRequest' | 'noteId'>) =>
  `${signal.repo}\u0000${signal.mergeRequest}\u0000${signal.noteId}`

/** The in-memory `LearningStore`. */
export function memoryLearnings(): LearningStore {
  const candidates = new Map<string, LearningCandidate>()
  const claims = new Map<string, string>()
  const reactions = new Map<string, ReactionSignal>()
  return {
    get: async (id) => clone(candidates.get(id)),
    list: async (filter) =>
      [...candidates.values()]
        .filter((candidate) => matchesLearningFilter(candidate, filter))
        .toSorted(byLearningUpdate)
        .map(clone),
    find: async (repo, key) =>
      clone(
        [...candidates.values()]
          .filter((candidate) => candidate.repo === repo && candidate.key === key)
          .toSorted((a, b) => binary(a.createdAt, b.createdAt) || binary(a.id, b.id))[0],
      ),
    async put(candidate) {
      candidates.set(candidate.id, clone(candidate))
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
