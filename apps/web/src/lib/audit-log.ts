import type { AuditEvent, GroupMatch, HistoryScope } from '@holtkeeper/api'

import type { HistoryQuery } from '../api/endpoints.ts'
import type { StatusTone } from '../ui/colors.ts'
import { auditActionLabel } from './audit-labels.ts'
import { type ScopeView, inView } from './home-scope.ts'

/** Areas of the audit log filter: an action prefix each. */
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

/** How far back the audit log goes. */
export type HistoryRange = '24h' | '7d' | '30d' | 'all'

export const historyRanges: readonly { id: HistoryRange; label: string }[] = [
  { id: '24h', label: '24 h' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'all', label: 'All' },
]

/** The audit log filters; `''` means any. */
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
  range: '7d',
}

const rangeMs: Record<Exclude<HistoryRange, 'all'>, number> = {
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
}

/**
 * The repositories a scope switch position narrows the audit log to, or `undefined` for no narrowing.
 * *My teams* keeps the visible repositories in the home groups, a group position those in the group.
 */
export function scopeRepos(
  view: ScopeView,
  scope: HistoryScope | undefined,
  homeGroups: readonly GroupMatch[],
): string[] | undefined {
  if (view === 'all' || !scope) return undefined
  return scope.repos
    .filter((entry) => inView(view, homeGroups, entry.groups))
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

/** An outcome in words: `Succeeded`, `Denied`, `Failed`. */
export const outcomeLabel = (outcome: string): string =>
  outcome === 'denied' ? 'Denied' : outcome === 'error' ? 'Failed' : 'Succeeded'

/** The repository when the event has one, else `credential:abc` or just the type. */
export const targetLabel = (target: AuditEvent['target']): string =>
  target.repo ?? (target.id ? `${target.type}:${target.id}` : target.type)

/** A change value as text: `—` when absent, strings as is, everything else as JSON. */
export function changeValue(value: unknown): string {
  if (value === undefined) return '—'
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

/**
 * Whether an event matches the audit log's search text: every word must appear in the action (its
 * label or raw name) or the target (id or type), or the text is a `#seq` or an event id prefix.
 * Empty text matches everything.
 */
export function auditEventMatches(event: AuditEvent, text: string): boolean {
  const query = text.trim().toLowerCase()
  if (!query) return true
  const seq = query.replace(/^#/, '').replaceAll(',', '')
  if (/^\d+$/.test(seq) && String(event.seq) === seq) return true
  if (event.id.toLowerCase().startsWith(query)) return true
  const haystack = [
    auditActionLabel(event.action),
    event.action,
    event.target.id ?? '',
    event.target.type,
  ]
    .join(' ')
    .toLowerCase()
  return query.split(/\s+/).every((word) => haystack.includes(word))
}
