import { type RepoTarget, scopeCoversRepo, scopeSpecificity } from '@holtkeeper/access'
import type { SettingEntry } from '@holtkeeper/store'

import type { SettingDefinition } from './definitions.ts'
import { isRetiredSetting } from './retired.ts'

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
  if (isRetiredSetting(key)) return []
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

/**
 * The entry for `key` that applies everywhere: among entries scoped `{ all: true }`, the most
 * recently updated. Entries of narrower scopes and retired keys are ignored; use it for `global`
 * settings.
 */
export function resolveGlobalSetting(
  entries: readonly SettingEntry[],
  key: string,
): SettingEntry | undefined {
  if (isRetiredSetting(key)) return undefined
  return entries
    .filter((entry) => entry.key === key && entry.scope.all === true)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
}

/** One setting as it applies to a repository. */
export interface EffectiveSetting {
  definition: SettingDefinition
  /** The entry that applies; absent when none covers the repository and `definition.default` applies. */
  entry?: SettingEntry
  /** Covering entries `entry` overrides, from narrow to broad. */
  overridden: SettingEntry[]
}

/**
 * Every definition in `definitions` order, retired keys left out, with the single entry that
 * applies to `repo` as a whole (values are never merged field by field). A `global` setting
 * counts only entries scoped `{ all: true }`. Entries of keys without a definition are ignored.
 */
export function effectiveSettings(
  definitions: readonly SettingDefinition[],
  entries: readonly SettingEntry[],
  repo: RepoTarget,
): EffectiveSetting[] {
  return definitions
    .filter((definition) => !isRetiredSetting(definition.key))
    .map((definition) => {
      const cascade = settingCascade(entries, definition.key, repo).filter(
        (entry) => !definition.global || entry.scope.all === true,
      )
      const [entry, ...overridden] = cascade
      return entry ? { definition, entry, overridden } : { definition, overridden }
    })
}
