import type { RepoTarget } from '@holtkeeper/access'
import type { SettingEntry } from '@holtkeeper/store'

import { type RepoFreeze, repoFreeze, repoFreezeSchema } from './definitions.ts'
import { settingCascade } from './resolve.ts'

/** A `repo.freeze` value that is still in force at `now`: valid and before its `until`, if any. */
export function activeFreeze(value: unknown, now: Date = new Date()): RepoFreeze | undefined {
  const parsed = repoFreezeSchema.safeParse(value)
  if (!parsed.success) return undefined
  const { until } = parsed.data
  return until === undefined || Date.parse(until) > now.getTime() ? parsed.data : undefined
}

/**
 * The `repo.freeze` entry in force for `repo` at `now`: the most specific covering entry among
 * those not past their `until`, so an expired entry is ignored and a broader one applies again.
 */
export function resolveRepoFreeze(
  entries: readonly SettingEntry[],
  repo: RepoTarget,
  now: Date = new Date(),
): { entry: SettingEntry; freeze: RepoFreeze } | undefined {
  for (const entry of settingCascade(entries, repoFreeze.key, repo)) {
    const freeze = activeFreeze(entry.value, now)
    if (freeze) return { entry, freeze }
  }
  return undefined
}
