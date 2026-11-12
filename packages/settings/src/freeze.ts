import type { RepoTarget } from '@holtkeeper/access'
import type { SettingEntry } from '@holtkeeper/store'

import { type RepoFreeze, repoFreeze, repoFreezeSchema } from './definitions.ts'
import { settingCascade } from './resolve.ts'

/**
 * A `repo.freeze` value that is still in force at `now`: valid and before its `until`, if any.
 * A lift (`frozen: false`) is in force the same way as a freeze.
 */
export function activeFreeze(value: unknown, now: Date = new Date()): RepoFreeze | undefined {
  const parsed = repoFreezeSchema.safeParse(value)
  if (!parsed.success) return undefined
  const { until } = parsed.data
  return until === undefined || Date.parse(until) > now.getTime() ? parsed.data : undefined
}

/** How `repo.freeze` applies to one repository. */
export interface ResolvedRepoFreeze {
  frozen: boolean
  /** Why it is frozen, or why a lift keeps it writable. */
  reason?: string
  until?: string
  /** The entry that decided it; absent when none in force covers the repository. */
  entry?: SettingEntry
  /** The deciding entry is a lift and a broader freeze in force would otherwise apply. */
  lifted?: true
}

/**
 * `repo.freeze` for `repo` at `now`: the most specific covering entry among those in force (valid,
 * not secret, before their `until`), so a narrower `frozen: false` entry lifts a broader freeze and
 * an expired entry lets the next broader one apply again. Without one the repository is writable.
 * `lifted` is set only when the deciding lift actually overrides a broader freeze in force.
 */
export function resolveRepoFreeze(
  entries: readonly SettingEntry[],
  repo: RepoTarget,
  now: Date = new Date(),
): ResolvedRepoFreeze {
  const inForce = settingCascade(entries, repoFreeze.key, repo).flatMap((entry) => {
    const freeze = entry.secret ? undefined : activeFreeze(entry.value, now)
    return freeze ? [{ entry, freeze }] : []
  })
  const [first, ...broader] = inForce
  if (!first) return { frozen: false }
  const { entry, freeze } = first
  return {
    frozen: freeze.frozen,
    ...(freeze.reason !== undefined && { reason: freeze.reason }),
    ...(freeze.until !== undefined && { until: freeze.until }),
    entry,
    ...(!freeze.frozen && broader.some((next) => next.freeze.frozen) && { lifted: true as const }),
  }
}
