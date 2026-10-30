import { type RepoTarget, scopeCoversRepo, scopeSpecificity } from '@holtkeeper/access'
import type { SettingEntry } from '@holtkeeper/store'

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
        scopeSpecificity(b.scope) - scopeSpecificity(a.scope) ||
        b.updatedAt.localeCompare(a.updatedAt),
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
