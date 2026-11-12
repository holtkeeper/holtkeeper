import type { RepoTarget } from '@holtkeeper/access'
import type { SettingEntry } from '@holtkeeper/store'

import { mergeRequestComments, mergeRequestCommentsSchema } from './definitions.ts'
import { resolveSetting } from './resolve.ts'

/** How `mergeRequests.comments` applies to one repository. */
export interface ResolvedMergeRequestComments {
  enabled: boolean
  reason?: string
  /** The entry that decided it; absent when none covers the repository and the default applies. */
  entry?: SettingEntry
}

/**
 * `mergeRequests.comments` for `repo`: the most specific covering entry, so a repository entry
 * turns reviews back on under a group that has them off. A secret or invalid winning value counts
 * as the default (on), with no entry; `reason` only while it is off.
 */
export function resolveMergeRequestComments(
  entries: readonly SettingEntry[],
  repo: RepoTarget,
): ResolvedMergeRequestComments {
  const entry = resolveSetting(entries, mergeRequestComments.key, repo)
  if (!entry || entry.secret) return { enabled: true }
  const parsed = mergeRequestCommentsSchema.safeParse(entry.value)
  if (!parsed.success) return { enabled: true }
  const { enabled, reason } = parsed.data
  return enabled || reason === undefined ? { enabled, entry } : { enabled, reason, entry }
}
