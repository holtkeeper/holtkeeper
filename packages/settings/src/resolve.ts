import { type RepoTarget, type Scope, scopeCoversRepo } from '@holtkeeper/access'
import type { SettingEntry } from '@holtkeeper/store'

const hasWildcard = (pattern: string) => /[*?[\]{}]/.test(pattern)

/**
 * How narrowly a scope targets repositories: everything (0) < groups (1) < path globs (2) <
 * exact paths (3). The most specific entry covering a repository wins.
 */
export function specificity(scope: Scope): number {
  if (scope.repos?.some((pattern) => !hasWildcard(pattern))) return 3
  if (scope.repos?.length) return 2
  if (scope.groups?.length) return 1
  return 0
}

/**
 * The entry for `key` that applies to `repo`: the most specific covering scope, and among equally
 * specific ones the most recently updated.
 */
export function resolveSetting(
  entries: readonly SettingEntry[],
  key: string,
  repo: RepoTarget,
): SettingEntry | undefined {
  return entries
    .filter((entry) => entry.key === key && scopeCoversRepo(entry.scope, repo))
    .toSorted(
      (a, b) =>
        specificity(b.scope) - specificity(a.scope) || b.updatedAt.localeCompare(a.updatedAt),
    )[0]
}

/** The winning entry for every key that has one for `repo`. */
export function resolveSettings(
  entries: readonly SettingEntry[],
  repo: RepoTarget,
): Map<string, SettingEntry> {
  const result = new Map<string, SettingEntry>()
  for (const key of new Set(entries.map((entry) => entry.key))) {
    const entry = resolveSetting(entries, key, repo)
    if (entry) result.set(key, entry)
  }
  return result
}
