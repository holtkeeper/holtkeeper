import { type RepoTarget, scopeCoversRepo, scopeSpecificity } from '@holtkeeper/access'
import type { SettingEntry } from '@holtkeeper/store'

/**
 * Every entry for `key` whose scope covers `repo`, in the order they override each other: most
 * specific scope first, and among equally specific ones the most recently updated. The first one
 * applies.
 */
export function settingCascade(
  entries: readonly SettingEntry[],
  key: string,
  repo: RepoTarget,
): SettingEntry[] {
  return entries
    .filter((entry) => entry.key === key && scopeCoversRepo(entry.scope, repo))
    .toSorted(
      (a, b) =>
        scopeSpecificity(b.scope) - scopeSpecificity(a.scope) ||
        b.updatedAt.localeCompare(a.updatedAt),
    )
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
  return settingCascade(entries, key, repo)[0]
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

/** `settingCascade` of every key that has an entry covering `repo`. */
export function settingCascades(
  entries: readonly SettingEntry[],
  repo: RepoTarget,
): Map<string, SettingEntry[]> {
  const result = new Map<string, SettingEntry[]>()
  for (const key of new Set(entries.map((entry) => entry.key))) {
    const cascade = settingCascade(entries, key, repo)
    if (cascade.length) result.set(key, cascade)
  }
  return result
}
