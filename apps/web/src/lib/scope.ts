import type { RepoRef, Scope } from '@holtkeeper/api'

import { repoKey } from './repo.ts'

/** Whether the scope covers nothing: not `all` and no groups or repository patterns. */
export const isEmptyScope = (scope: Scope): boolean =>
  !scope.all && !scope.groups?.length && !scope.repos?.length

/** `everything`, or a list like `group games, work:games/**`. */
export function describeScope(scope: Scope): string {
  if (scope.all) return 'everything'
  const parts = [...(scope.groups ?? []).map((group) => `group ${group}`), ...(scope.repos ?? [])]
  return parts.length ? parts.join(', ') : 'nothing'
}

/** Drops empty lists and duplicates, and drops everything else when `all` is set. */
export function normalizeScope(scope: Scope): Scope {
  if (scope.all) return { all: true }
  const groups = [...new Set((scope.groups ?? []).map((g) => g.trim()).filter(Boolean))]
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
