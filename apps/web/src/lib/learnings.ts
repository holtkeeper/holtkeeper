import {
  AUTO_ACCEPT_ACTOR,
  type AcceptLearningsResult,
  type GuideScopeKey,
  type GuideSectionName,
  type LearningCandidateView,
  type LearningSourceKind,
  type ReactionTotals,
} from '@holtkeeper/api'

import { type Space, candidatesInSpace } from './guide.ts'
import { repoKey } from './repo.ts'

export const sourceKindLabel: Record<LearningSourceKind, string> = {
  'review-reply': 'Review reply',
  mcp: 'Over MCP',
  merged: 'Merged',
}

export const learningSourceKinds: readonly LearningSourceKind[] = ['review-reply', 'merged', 'mcp']

/** Confidence in words: 1–2 Low, 3 Medium, 4–5 High. */
export const confidenceLabel = (confidence: number): 'Low' | 'Medium' | 'High' =>
  confidence >= 4 ? 'High' : confidence === 3 ? 'Medium' : 'Low'

/** What a screen reader hears for the confidence bars, e.g. "Confidence high, 4 of 5". */
export const confidenceAria = (confidence: number): string =>
  `Confidence ${confidenceLabel(confidence).toLowerCase()}, ${confidence} of 5`

/** Filter choices for confidence, in the order the filter lists them. */
export const confidenceLevels = ['High', 'Medium', 'Low'] as const
export type ConfidenceLevel = (typeof confidenceLevels)[number]

/** Replies and a direct proposal that back a candidate. */
export const evidenceOf = (candidate: Pick<LearningCandidateView, 'sources' | 'proposal'>) =>
  candidate.sources.length + (candidate.proposal ? 1 : 0)

/**
 * Candidates of the space: every one for *All*, else those whose repository is among `repos`
 * (the `forge:path` keys the space covers); a repository space also keeps its own repository.
 */
export function learningsInSpace<T extends Pick<LearningCandidateView, 'repo'>>(
  candidates: readonly T[],
  space: Space,
  repos: readonly string[],
): T[] {
  if (space.kind === 'all') return candidatesInSpace(candidates, undefined)
  return candidatesInSpace(
    candidates,
    new Set(space.kind === 'repo' ? [...repos, repoKey(space.repo)] : repos),
  )
}

/** What narrows the Learnings table. */
export interface LearningQuery {
  source?: LearningSourceKind
  sections: readonly GuideSectionName[]
  confidence: readonly ConfidenceLevel[]
}

export type LearningSort = 'evidence' | 'confidence' | 'newest'

export const learningSorts: readonly { id: LearningSort; label: string }[] = [
  { id: 'evidence', label: 'Evidence' },
  { id: 'confidence', label: 'Confidence' },
  { id: 'newest', label: 'Newest' },
]

/** Candidates matching the source, section and confidence choices, in `sort` order. */
export function filterLearnings<T extends LearningCandidateView>(
  candidates: readonly T[],
  query: LearningQuery,
  sort: LearningSort = 'evidence',
): T[] {
  const newest = (a: T, b: T) => b.updatedAt.localeCompare(a.updatedAt)
  const order: Record<LearningSort, (a: T, b: T) => number> = {
    evidence: (a, b) =>
      evidenceOf(b) - evidenceOf(a) || b.confidence - a.confidence || newest(a, b),
    confidence: (a, b) =>
      b.confidence - a.confidence || evidenceOf(b) - evidenceOf(a) || newest(a, b),
    newest,
  }
  return candidates
    .filter(
      (candidate) =>
        (!query.source || candidate.sourceKind === query.source) &&
        (!query.sections.length || query.sections.includes(candidate.section)) &&
        (!query.confidence.length ||
          query.confidence.includes(confidenceLabel(candidate.confidence))),
    )
    .toSorted(order[sort])
}

/** Candidates per source kind, plus `all`, for the source tabs. */
export function sourceCounts(
  candidates: readonly Pick<LearningCandidateView, 'sourceKind'>[],
): Record<LearningSourceKind | 'all', number> {
  const counts = { all: candidates.length, 'review-reply': 0, mcp: 0, merged: 0 }
  for (const candidate of candidates) counts[candidate.sourceKind] += 1
  return counts
}

/** Ids a batch accept may take: proposed candidates the caller may decide. */
export const selectableIds = (
  candidates: readonly Pick<LearningCandidateView, 'id' | 'status' | 'canDecide'>[],
): string[] =>
  candidates
    .filter((candidate) => candidate.status === 'proposed' && candidate.canDecide)
    .map((candidate) => candidate.id)

/** The selection after a batch accept: only the candidates that failed stay selected. */
export const selectionAfter = (result: AcceptLearningsResult): Set<string> =>
  new Set(result.failed.map((failure) => failure.id))

/**
 * The scope a candidate's proposal points at among those the caller may pick: its `targetScope`,
 * else the first of its `suggestedScope` kind, else the first.
 */
export const suggestedScopeOf = (
  candidate: Pick<LearningCandidateView, 'scopes' | 'suggestedScope' | 'targetScope'>,
): GuideScopeKey | undefined =>
  candidate.scopes.find((key) => key === candidate.targetScope) ??
  candidate.scopes.find((key) => key.startsWith(`${candidate.suggestedScope}:`)) ??
  candidate.scopes[0]

/** Accepted by the `learnings.autoAccept` policy and not confirmed by a person since. */
export const isAutoAccepted = (
  candidate: Pick<LearningCandidateView, 'status' | 'decidedBy'>,
): boolean => candidate.status === 'accepted' && candidate.decidedBy === AUTO_ACCEPT_ACTOR.id

/** Accepted candidates per Guide section, in the order of `sections`; empty sections left out. */
export function acceptedBySection(
  candidates: readonly Pick<LearningCandidateView, 'status' | 'section'>[],
  sections: readonly GuideSectionName[],
): { section: GuideSectionName; count: number }[] {
  return sections
    .map((section) => ({
      section,
      count: candidates.filter((c) => c.status === 'accepted' && c.section === section).length,
    }))
    .filter((row) => row.count > 0)
}

/** Share of 👍 among 👍 and 👎 in whole percent; `undefined` without reactions. */
export const helpfulShare = (row: Pick<ReactionTotals, 'up' | 'down'>): number | undefined =>
  row.up + row.down ? Math.round((row.up / (row.up + row.down)) * 100) : undefined

/** Reaction totals summed over categories. */
export const reactionSum = (rows: readonly ReactionTotals[]) =>
  rows.reduce(
    (sum, row) => ({
      comments: sum.comments + row.comments,
      up: sum.up + row.up,
      down: sum.down + row.down,
    }),
    { comments: 0, up: 0, down: 0 },
  )
