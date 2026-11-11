import type { AuditEvent, AuditVerifyResponse, GroupMatch, HistoryScope } from '@holtkeeper/api'

import type { HistoryQuery } from '../api/endpoints.ts'
import type { StatusTone } from '../ui/colors.ts'
import { type ScopeView, inHomeGroups } from './home-scope.ts'

/** Areas of the History filter: an action prefix each. */
export const historyAreas = [
  { id: 'release', label: 'Releases' },
  { id: 'setting', label: 'Settings' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'user', label: 'Access' },
  { id: 'credential', label: 'Credentials' },
  { id: 'repo', label: 'Repositories' },
  { id: 'job', label: 'Jobs' },
  { id: 'mr_policy', label: 'MR policies' },
  { id: 'analysis', label: 'Analyses' },
] as const

/** How far back the History list goes. */
export type HistoryRange = '24h' | '7d' | '30d' | 'all'

export const historyRanges: readonly { id: HistoryRange; label: string }[] = [
  { id: '24h', label: '24h' },
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
  { id: 'all', label: 'All' },
]

/** The History filters bar; `''` means any. */
export interface HistoryFilters {
  actor: string
  area: string
  repo: string
  outcome: string
  range: HistoryRange
}

export const emptyHistoryFilters: HistoryFilters = {
  actor: '',
  area: '',
  repo: '',
  outcome: '',
  range: '30d',
}

const rangeMs: Record<Exclude<HistoryRange, 'all'>, number> = {
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
}

/**
 * The repositories a scope switch position narrows History to, or `undefined` for no narrowing.
 * *My team* keeps the visible repositories in the home groups, *Other teams* the rest.
 */
export function scopeRepos(
  view: ScopeView,
  scope: HistoryScope | undefined,
  homeGroups: readonly GroupMatch[],
): string[] | undefined {
  if (view === 'all' || !scope) return undefined
  const mine = view === 'mine'
  return scope.repos
    .filter((entry) => inHomeGroups(homeGroups, entry.groups) === mine)
    .map((entry) => entry.repo)
}

/**
 * The API query for the filters: a picked repository wins over the scope's list, the range
 * becomes `from` relative to `now`.
 */
export function historyQueryOf(
  filters: HistoryFilters,
  repos: readonly string[] | undefined,
  now: Date,
): HistoryQuery {
  const query: HistoryQuery = {}
  if (filters.actor) query.actor = filters.actor
  if (filters.area) query.action = filters.area
  if (filters.outcome) query.outcome = filters.outcome
  if (filters.repo) query.repos = filters.repo
  else if (repos) query.repos = repos.join(',')
  if (filters.range !== 'all')
    query.from = new Date(now.getTime() - rangeMs[filters.range]).toISOString()
  return query
}

/** `release.versioned` as words: `release versioned`. */
export const actionLabel = (action: string): string =>
  action.replaceAll('.', ' ').replaceAll('_', ' ')

/** Status tone of an outcome. */
export const outcomeTone = (outcome: string): StatusTone =>
  outcome === 'denied' ? 'warning' : outcome === 'error' ? 'danger' : 'success'

/** The repository when the event has one, else `credential:abc` or just the type. */
export const targetLabel = (target: AuditEvent['target']): string =>
  target.repo ?? (target.id ? `${target.type}:${target.id}` : target.type)

/** A change value as text: `—` when absent, strings as is, everything else as JSON. */
export function changeValue(value: unknown): string {
  if (value === undefined) return '—'
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

const brokenReason = {
  hash: 'its content does not match its hash',
  link: 'it does not link to the event before it',
  gap: 'events before it are missing',
  tail: 'events at the end of the range are missing',
} as const

/** A verification result as a notice: tone, title and explanation. */
export function verificationSummary(result: AuditVerifyResponse): {
  tone: 'success' | 'danger'
  title: string
  description: string
} {
  const range =
    result.firstSeq !== undefined && result.lastSeq !== undefined
      ? ` (#${result.firstSeq}–#${result.lastSeq})`
      : ''
  if (result.ok || !result.broken)
    return {
      tone: 'success',
      title: 'Chain intact',
      description: `${result.checked} ${result.checked === 1 ? 'event' : 'events'} checked${range}.`,
    }
  return {
    tone: 'danger',
    title: `Chain broken at #${result.broken.seq}`,
    description: `${brokenReason[result.broken.reason]}; ${result.checked} checked${range}.`,
  }
}
