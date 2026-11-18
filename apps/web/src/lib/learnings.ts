import type {
  LearningCreateBody,
  LearningOrigin,
  LearningPatch,
  LearningSource,
  LearningStatus,
  LearningView,
  ReactionTotals,
  RuleAgent,
  Scope,
} from '@holtkeeper/api'

import { daysUntil } from './format.ts'

/** Every status in display order, with its label and tag tone. */
export const learningStatuses: readonly {
  id: LearningStatus
  label: string
  tone: 'warning' | 'success' | 'default' | 'danger'
}[] = [
  { id: 'pending', label: 'Pending', tone: 'warning' },
  { id: 'active', label: 'Active', tone: 'success' },
  { id: 'expired', label: 'Expired', tone: 'default' },
  { id: 'rejected', label: 'Rejected', tone: 'danger' },
]

/** What the Learnings tab lists before anyone touches the status filter. */
export const defaultLearningStatuses: readonly LearningStatus[] = ['pending', 'active']

export const isLearningStatus = (value: unknown): value is LearningStatus =>
  learningStatuses.some((status) => status.id === value)

export const learningStatusOf = (status: LearningStatus) =>
  learningStatuses.find((each) => each.id === status) ?? learningStatuses[0]!

/** Every origin in display order, with its label. */
export const learningOrigins: readonly { id: LearningOrigin; label: string }[] = [
  { id: 'reply', label: 'Review reply' },
  { id: 'miner', label: 'Rule miner' },
  { id: 'agent', label: 'Agent' },
  { id: 'person', label: 'Person' },
]

export const isLearningOrigin = (value: unknown): value is LearningOrigin =>
  learningOrigins.some((origin) => origin.id === value)

export const originLabel = (origin: LearningOrigin): string =>
  learningOrigins.find((each) => each.id === origin)?.label ?? origin

const inDays = (days: number): string =>
  days <= 0 ? 'today' : days === 1 ? 'in 1 day' : `in ${days} days`

/**
 * When a learning changes state by itself, in words: `Activates in 2 days` for a pending one,
 * `Expires in 71 days` for an active one; nothing for the rest or without a date.
 */
export function learningTiming(
  learning: Pick<LearningView, 'status' | 'activeAt' | 'expiresAt'>,
  now: Date = new Date(),
): { label: string; soon: boolean } | undefined {
  if (learning.status === 'pending') {
    const days = Math.max(0, daysUntil(learning.activeAt, now))
    return { label: `Activates ${inDays(days)}`, soon: days <= 1 }
  }
  if (learning.status === 'active' && learning.expiresAt) {
    const days = Math.max(0, daysUntil(learning.expiresAt, now))
    return { label: `Expires ${inDays(days)}`, soon: days < 14 }
  }
  return undefined
}

/** Counts for the summary strip: pending, active, and active ones expiring within 14 days. */
export function learningTotals(
  learnings: readonly Pick<LearningView, 'status' | 'activeAt' | 'expiresAt'>[],
  now: Date = new Date(),
): { pending: number; active: number; expiringSoon: number } {
  let pending = 0
  let active = 0
  let expiringSoon = 0
  for (const learning of learnings) {
    if (learning.status === 'pending') pending += 1
    if (learning.status !== 'active') continue
    active += 1
    if (learningTiming(learning, now)?.soon) expiringSoon += 1
  }
  return { pending, active, expiringSoon }
}

/** `!318 acme/round/web`, the repository alone, or `Direct proposal` for a source without one. */
export function sourceLabel(source: LearningSource): string {
  const repo = source.repo ? source.repo.slice(source.repo.indexOf(':') + 1) : undefined
  if (source.mergeRequest !== undefined)
    return repo ? `!${source.mergeRequest} ${repo}` : `!${source.mergeRequest}`
  return repo ?? 'Direct proposal'
}

/** What the learning editor holds. */
export interface LearningDraft {
  text: string
  reason: string
  scope: Scope
  files: string[]
  agents: RuleAgent[]
}

export const emptyLearningDraft = (scope: Scope = { all: true }): LearningDraft => ({
  text: '',
  reason: '',
  scope,
  files: [],
  agents: [],
})

export const learningDraftOf = (learning: LearningView): LearningDraft => ({
  text: learning.text,
  reason: learning.reason ?? '',
  scope: learning.scope,
  files: [...(learning.files ?? [])],
  agents: [...(learning.agents ?? [])],
})

/** What keeps a draft from saving, in words; empty when it may be saved. */
export function learningDraftProblems(draft: LearningDraft): string[] {
  const scope = draft.scope
  return [
    ...(draft.text.trim() ? [] : ['Write the learning']),
    ...(!scope.all && !scope.teams?.length && !scope.repos?.length ? ['Pick a scope'] : []),
  ]
}

export function learningCreateOf(draft: LearningDraft): LearningCreateBody {
  const reason = draft.reason.trim()
  return {
    text: draft.text.trim(),
    scope: draft.scope,
    ...(reason ? { reason } : {}),
    ...(draft.files.length ? { files: draft.files } : {}),
    ...(draft.agents.length ? { agents: draft.agents } : {}),
  }
}

/** The full edit of a learning: cleared fields go as `null` so the server drops them. */
export function learningPatchOf(draft: LearningDraft): LearningPatch {
  const reason = draft.reason.trim()
  return {
    text: draft.text.trim(),
    scope: draft.scope,
    reason: reason || null,
    files: draft.files.length ? draft.files : null,
    agents: draft.agents.length ? draft.agents : null,
  }
}

/** Share of 👍 among reactions, in percent; undefined without reactions. */
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
