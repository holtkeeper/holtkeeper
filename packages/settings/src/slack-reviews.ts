import type { RepoTarget } from '@holtkeeper/access'
import type { SettingEntry } from '@holtkeeper/store'

import { slackReviews, slackReviewsSchema } from './definitions.ts'
import { resolveSetting } from './resolve.ts'

/**
 * The Slack channel ids `slack.reviews` binds to `repo`: those of the most specific covering
 * entry, so a group entry overrides the global one and an entry without channels turns it off
 * there. No entry, a secret or an invalid winning value bind none.
 */
export function resolveSlackReviewChannels(
  entries: readonly SettingEntry[],
  repo: RepoTarget,
): string[] {
  const entry = resolveSetting(entries, slackReviews.key, repo)
  if (!entry || entry.secret) return []
  return slackReviewsSchema.safeParse(entry.value).data?.channels ?? []
}
