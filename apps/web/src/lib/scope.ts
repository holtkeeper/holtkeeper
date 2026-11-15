import type { RepoRef, Scope } from '@holtkeeper/api'
import { folderPattern, pathAncestors, patternMatches } from '@holtkeeper/api'

import { repoKey } from './repo.ts'
import { type TeamTitleOf, keyAsTitle } from './team-titles.ts'

/** Whether the scope covers nothing: not `all` and no teams or repository patterns. */
export const isEmptyScope = (scope: Scope): boolean =>
  !scope.all && !scope.teams?.length && !scope.repos?.length

/**
 * `everything`, or a list like `team Games, work:acme/round/**`: teams by `titleOf` (default their
 * keys), then path patterns as written.
 */
export function describeScope(scope: Scope, titleOf: TeamTitleOf = keyAsTitle): string {
  if (scope.all) return 'everything'
  const parts = [
    ...(scope.teams ?? []).map((team) => `team ${titleOf(team)}`),
    ...(scope.repos ?? []),
  ]
  return parts.length ? parts.join(', ') : 'nothing'
}

/** Drops empty lists and duplicates, and drops everything else when `all` is set. */
export function normalizeScope(scope: Scope): Scope {
  if (scope.all) return { all: true }
  const teams = [...new Set((scope.teams ?? []).map((t) => t.trim()).filter(Boolean))]
  const repos = [...new Set((scope.repos ?? []).map((r) => r.trim()).filter(Boolean))]
  return { ...(teams.length ? { teams } : {}), ...(repos.length ? { repos } : {}) }
}

/**
 * Checks a repository pattern: a path glob optionally prefixed by a forge id (`work:acme/**`).
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

/**
 * Checks a pattern that defines what a forge or team holds (fleet include, team owns and
 * consumes): a valid pattern whose first segment is literal, as the server requires (`acme/**`,
 * not `**\/web`).
 */
export function validateRootedPattern(pattern: string): string | undefined {
  const error = validateRepoPattern(pattern)
  if (error) return error
  const value = pattern.trim()
  const separator = value.indexOf(':')
  const first = (separator > 0 ? value.slice(separator + 1) : value).split('/')[0] ?? ''
  return /[*?[\]{}]/.test(first) ? 'Start with a folder, e.g. acme/**' : undefined
}

/** Ranks scopes from broad to narrow for display: everything, teams, then patterns. */
export function scopeOrder(scope: Scope): number {
  if (scope.all) return 0
  if (scope.teams?.length) return 1
  return 2
}

/**
 * Whether `scope` covers a repository: everything, one of its owner `teams` named, or a path
 * pattern matching it (forge prefix optional). Mirrors the server for previews; the server decides.
 */
export function scopeCoversRepo(
  scope: Scope,
  repo: { repo: RepoRef; teams: readonly string[] },
): boolean {
  if (scope.all) return true
  if (scope.teams?.some((team) => repo.teams.includes(team))) return true
  return (scope.repos ?? []).some((pattern) =>
    patternMatches(pattern.trim(), repo.repo.forge, repo.repo.path),
  )
}

/** The repositories of `repos` that one path pattern matches. */
export const reposMatching = <T extends { repo: RepoRef }>(
  pattern: string,
  repos: readonly T[],
): T[] => repos.filter((r) => patternMatches(pattern.trim(), r.repo.forge, r.repo.path))

/** What a repository or team page edits settings and knowledge for. */
export type ScopeFocus = { kind: 'repo'; repo: RepoRef } | { kind: 'team'; team: string }

/** The scope a new entry made on a focus page starts with. */
export const scopeOfFocus = (focus: ScopeFocus): Scope =>
  focus.kind === 'repo' ? { repos: [repoKey(focus.repo)] } : { teams: [focus.team] }

/**
 * Whether the scope names the focus itself: the team, or the repository's exact path (with or
 * without its forge). Broader entries that merely cover a repository do not count.
 */
export function namesFocus(scope: Scope, focus: ScopeFocus): boolean {
  if (focus.kind === 'team') return scope.teams?.includes(focus.team) ?? false
  return (scope.repos ?? []).some(
    (pattern) => pattern === repoKey(focus.repo) || pattern === focus.repo.path,
  )
}

/** Whether the scope covers more than one team or pattern, or everything. */
export const isSharedScope = (scope: Scope): boolean =>
  scope.all === true || (scope.teams?.length ?? 0) + (scope.repos?.length ?? 0) > 1

/**
 * Folder patterns (`forge:folder/**`) for every folder holding one of `repos`, sorted, as
 * suggestions for a path pattern field. The forge prefix is dropped while there is a single forge.
 */
export function folderPatterns(repos: readonly RepoRef[]): string[] {
  const forges = new Set(repos.map((repo) => repo.forge))
  const patterns = new Set<string>()
  for (const repo of repos)
    for (const folder of pathAncestors(repo.path))
      patterns.add(folderPattern(folder, forges.size > 1 ? repo.forge : undefined))
  return [...patterns].toSorted()
}

/** How many of `repos` the scope's path patterns match together, and the first few of them. */
export interface PatternPreview<T> {
  total: number
  sample: T[]
}

/** Previews the repositories a list of path patterns reaches, with at most `limit` samples. */
export function previewPatterns<T extends { repo: RepoRef }>(
  patterns: readonly string[],
  repos: readonly T[],
  limit = 5,
): PatternPreview<T> {
  const matched = repos.filter((r) =>
    patterns.some((pattern) => patternMatches(pattern.trim(), r.repo.forge, r.repo.path)),
  )
  return { total: matched.length, sample: matched.slice(0, limit) }
}
