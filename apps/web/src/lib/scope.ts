import type { GroupMatch, RepoRef, Scope } from '@holtkeeper/api'

import { repoKey, validateGroupId } from './repo.ts'

/** Whether the scope covers nothing: not `all` and no groups or repository patterns. */
export const isEmptyScope = (scope: Scope): boolean =>
  !scope.all && !scope.groups?.length && !scope.repos?.length

/** A group list entry as typed in the panel: `frontend`, or `frontend + storefront`. */
export const formatGroupMatch = (entry: GroupMatch): string =>
  typeof entry === 'string' ? entry : entry.join(' + ')

/** Reads `formatGroupMatch` text back; a single group stays a plain name. */
export function parseGroupMatch(text: string): GroupMatch {
  const groups = [...new Set(text.split('+').map((group) => group.trim()))].filter(Boolean)
  return groups.length === 1 ? (groups[0] ?? '') : groups
}

/** Checks a group list entry typed in the panel; `undefined` when it looks valid. */
export const validateGroupMatch = (text: string): string | undefined =>
  text
    .split('+')
    .map(validateGroupId)
    .find((error) => error !== undefined)

/** `everything`, or a list like `group games, group frontend + storefront, work:games/**`. */
export function describeScope(scope: Scope): string {
  if (scope.all) return 'everything'
  const parts = [
    ...(scope.groups ?? []).map((entry) => `group ${formatGroupMatch(entry)}`),
    ...(scope.repos ?? []),
  ]
  return parts.length ? parts.join(', ') : 'nothing'
}

/** Drops empty lists and duplicates, and drops everything else when `all` is set. */
export function normalizeScope(scope: Scope): Scope {
  if (scope.all) return { all: true }
  const byText = new Map(
    (scope.groups ?? [])
      .map((entry) => parseGroupMatch(formatGroupMatch(entry)))
      .map((entry) => [formatGroupMatch(entry), entry]),
  )
  byText.delete('')
  const groups = [...byText.values()]
  const repos = [...new Set((scope.repos ?? []).map((r) => r.trim()).filter(Boolean))]
  return { ...(groups.length ? { groups } : {}), ...(repos.length ? { repos } : {}) }
}

/**
 * Checks a repository pattern: a path glob optionally prefixed by a forge id (`work:games/**`).
 * Returns an error message, or `undefined` when the pattern looks valid.
 */
export function validateRepoPattern(pattern: string): string | undefined {
  const value = pattern.trim()
  if (!value) return 'Pattern is empty'
  if (/\s/.test(value)) return 'Patterns cannot contain spaces'
  const separator = value.indexOf(':')
  if (separator === 0) return 'Forge id before ":" is empty'
  const glob = separator > 0 ? value.slice(separator + 1) : value
  if (!glob) return 'Path after ":" is empty'
  if (glob.startsWith('/')) return 'Paths are relative, without a leading "/"'
  return undefined
}

/** Ranks scopes from broad to narrow for display: everything, groups, then patterns. */
export function scopeOrder(scope: Scope): number {
  if (scope.all) return 0
  if (scope.groups?.length) return 1
  return 2
}

/** What a repository or group page edits settings and knowledge for. */
export type ScopeFocus = { kind: 'repo'; repo: RepoRef } | { kind: 'group'; group: string }

/** The scope a new entry made on a focus page starts with. */
export const scopeOfFocus = (focus: ScopeFocus): Scope =>
  focus.kind === 'repo' ? { repos: [repoKey(focus.repo)] } : { groups: [focus.group] }

/**
 * Whether the scope names the focus itself: the group, or the repository's exact path (with or
 * without its forge). Broader entries that merely cover a repository do not count.
 */
export function namesFocus(scope: Scope, focus: ScopeFocus): boolean {
  if (focus.kind === 'group') return scope.groups?.includes(focus.group) ?? false
  return (scope.repos ?? []).some(
    (pattern) => pattern === repoKey(focus.repo) || pattern === focus.repo.path,
  )
}

/** Whether the scope covers more than one group or pattern, or everything. */
export const isSharedScope = (scope: Scope): boolean =>
  scope.all === true || (scope.groups?.length ?? 0) + (scope.repos?.length ?? 0) > 1
