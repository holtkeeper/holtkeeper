import type { RepoTarget, Scope } from '@holtkeeper/access'
import type {
  Learning,
  LearningOrigin,
  LearningSource,
  RuleAgent,
  Timestamp,
} from '@holtkeeper/store'

import { filesMatch, ruleApplies } from './model.ts'

/** How long learnings wait and how long they live without reinforcement. */
export interface LearningPolicy {
  /** Days a new learning stays `pending` before it becomes active by itself; 0 activates at once. */
  approvalDelayDays: number
  /** Days an active learning lives without reinforcement before it expires. */
  expiryDays: number
}

export const DEFAULT_LEARNING_POLICY: LearningPolicy = { approvalDelayDays: 3, expiryDays: 90 }

/** Word overlap at or above which two learnings count as the same rule. */
export const DUPLICATE_OVERLAP = 0.8

const DAY = 24 * 3600 * 1000

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []

/** `text` normalized: its lowercase words joined by single spaces. */
export const learningKey = (text: string): string => words(text).join(' ')

/** Jaccard overlap of the word sets of `a` and `b`, 0 to 1. */
export function wordOverlap(a: string, b: string): number {
  const left = new Set(words(a))
  const right = new Set(words(b))
  if (!left.size || !right.size) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared++
  return shared / (left.size + right.size - shared)
}

/**
 * The learning among `existing` that states the same rule as `text`: the same key, or word
 * overlap of at least `DUPLICATE_OVERLAP`, best overlap first. Rejected learnings count, so a
 * rule people turned down is not proposed again.
 */
export function findDuplicateLearning(
  text: string,
  existing: readonly Learning[],
): Learning | undefined {
  const key = learningKey(text)
  const same = existing.find((learning) => learning.key === key)
  if (same) return same
  let best: { learning: Learning; overlap: number } | undefined
  for (const learning of existing) {
    const overlap = wordOverlap(text, learning.text)
    if (overlap >= DUPLICATE_OVERLAP && (!best || overlap > best.overlap))
      best = { learning, overlap }
  }
  return best?.learning
}

/** What a new learning is made of. */
export interface LearningDraft {
  text: string
  reason?: string
  scope: Scope
  files?: string[]
  agents?: RuleAgent[]
  origin: LearningOrigin
  source?: LearningSource
  model?: string
  costUsd?: number
}

const plusDays = (at: Timestamp, days: number): Timestamp =>
  new Date(Date.parse(at) + days * DAY).toISOString()

/**
 * A new learning: `pending` until `approvalDelayDays` pass, or `active` at once when the delay is
 * 0 or `approved` is set (a person wrote it).
 */
export function newLearning(
  draft: LearningDraft,
  options: { id: string; now: Timestamp; policy: LearningPolicy; approvedBy?: string },
): Learning {
  const text = draft.text.trim()
  const immediate = options.approvedBy !== undefined || options.policy.approvalDelayDays <= 0
  return {
    id: options.id,
    text,
    key: learningKey(text),
    ...(draft.reason?.trim() && { reason: draft.reason.trim() }),
    scope: draft.scope,
    ...(draft.files?.length && { files: draft.files }),
    ...(draft.agents?.length && { agents: draft.agents }),
    origin: draft.origin,
    status: immediate ? 'active' : 'pending',
    sources: draft.source ? [draft.source] : [],
    ...(draft.model && { model: draft.model }),
    ...(draft.costUsd !== undefined && { costUsd: draft.costUsd }),
    createdAt: options.now,
    updatedAt: options.now,
    activeAt: immediate ? options.now : plusDays(options.now, options.policy.approvalDelayDays),
    lastReinforcedAt: options.now,
    uses: 0,
    actedOn: 0,
    votesUp: 0,
    votesDown: 0,
    ...(options.approvedBy !== undefined && {
      decidedBy: options.approvedBy,
      decidedAt: options.now,
    }),
  }
}

const sameSource = (a: LearningSource, b: LearningSource) =>
  (a.noteId !== undefined && a.noteId === b.noteId && a.repo === b.repo) ||
  (a.url !== undefined && a.url === b.url)

/** What confirmed or contradicted a learning. */
export interface LearningSignal {
  /** Another place that taught the same rule. */
  source?: LearningSource
  /** A review comment cited it. */
  cited?: boolean
  /** That comment's finding was fixed. */
  actedOn?: boolean
  vote?: 'up' | 'down'
}

/**
 * The learning after `signal`. A new source, a fixed citation or an up vote reinforce it (an
 * expired learning becomes active again); a citation alone counts as a use; a down vote never
 * reinforces. A source it already has changes nothing.
 */
export function reinforceLearning(
  learning: Learning,
  signal: LearningSignal,
  now: Timestamp,
): Learning {
  const newSource =
    signal.source && !learning.sources.some((source) => sameSource(source, signal.source!))
      ? signal.source
      : undefined
  const reinforced = Boolean(newSource || signal.actedOn || signal.vote === 'up')
  if (!reinforced && !signal.cited && !signal.vote) return learning
  return {
    ...learning,
    sources: newSource ? [...learning.sources, newSource] : learning.sources,
    uses: learning.uses + (signal.cited ? 1 : 0),
    actedOn: learning.actedOn + (signal.actedOn ? 1 : 0),
    votesUp: learning.votesUp + (signal.vote === 'up' ? 1 : 0),
    votesDown: learning.votesDown + (signal.vote === 'down' ? 1 : 0),
    updatedAt: now,
    ...(reinforced && { lastReinforcedAt: now }),
    ...(reinforced && learning.status === 'expired' && { status: 'active' as const }),
  }
}

/**
 * The learning with its status brought up to `now`: a `pending` one past `activeAt` becomes
 * `active`, an `active` one not reinforced for `expiryDays` becomes `expired`. Returns the same
 * object when nothing changes.
 */
export function settleLearning(
  learning: Learning,
  now: Timestamp,
  policy: LearningPolicy,
): Learning {
  if (learning.status === 'pending' && learning.activeAt <= now) {
    return settleLearning({ ...learning, status: 'active', updatedAt: now }, now, policy)
  }
  if (
    learning.status === 'active' &&
    Date.parse(now) - Date.parse(learning.lastReinforcedAt) > policy.expiryDays * DAY
  ) {
    return { ...learning, status: 'expired', updatedAt: now }
  }
  return learning
}

/** A person's decision on a learning: approving activates it now, rejecting keeps it out for good. */
export function decideLearning(
  learning: Learning,
  decision: 'approve' | 'reject',
  by: string,
  now: Timestamp,
): Learning {
  return {
    ...learning,
    status: decision === 'approve' ? 'active' : 'rejected',
    ...(decision === 'approve' && { activeAt: now, lastReinforcedAt: now }),
    decidedBy: by,
    decidedAt: now,
    updatedAt: now,
  }
}

/** How much a learning has proven itself; higher ranks first. */
export const learningScore = (learning: Learning): number =>
  learning.actedOn * 3 +
  learning.uses +
  learning.votesUp * 2 -
  learning.votesDown * 3 +
  learning.sources.length

/** Best `learningScore` first, then most recently reinforced, then by id. */
export const byLearningRank = (a: Learning, b: Learning): number =>
  learningScore(b) - learningScore(a) ||
  (a.lastReinforcedAt < b.lastReinforcedAt
    ? 1
    : a.lastReinforcedAt > b.lastReinforcedAt
      ? -1
      : 0) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * Whether an active learning applies to a task: its scope covers `repo`, `agent` reads it, and,
 * when it names files and the task says which files it touches, one of them matches.
 */
export function learningApplies(
  learning: Learning,
  repo: RepoTarget,
  agent: RuleAgent,
  files?: readonly string[],
): boolean {
  if (learning.status !== 'active' || !ruleApplies(learning, repo, agent)) return false
  return !learning.files?.length || files === undefined || filesMatch(learning.files, files)
}
