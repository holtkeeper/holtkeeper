import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { RepoRef } from '@holtkeeper/forge'
import { mergeRequestComments, resolveMergeRequestComments } from '@holtkeeper/settings'
import type { Job, Store } from '@holtkeeper/store'

import { repoTarget } from './context.ts'

/** The built-in review analyzer, which `mergeRequests.comments` keeps off merge requests. */
export const REVIEW_ANALYZER = 'review'

/**
 * Whether `kind` reviews merge requests: the built-in `review` or the analyzer the `review`
 * command runs (`jobs.commands.review.analyzer`).
 */
export function isReviewAnalyzer(config: HoltkeeperConfig, kind: string): boolean {
  return kind === REVIEW_ANALYZER || kind === config.jobs?.commands?.review?.analyzer
}

/**
 * Why a claimed job must not run because `mergeRequests.comments` is off on its repository, for
 * `WorkerOptions.cancelReason`: reviews queued before the setting was turned off.
 */
export function reviewCancelReason(store: Pick<Store, 'settings'>, config: HoltkeeperConfig) {
  return async (job: Pick<Job, 'analyzer' | 'repo'>): Promise<string | undefined> => {
    if (!isReviewAnalyzer(config, job.analyzer)) return undefined
    const off = await commentsOffFor(store, config, job.repo)
    if (!off) return undefined
    return `merge request reviews are off${off.reason ? `: ${off.reason}` : ''}`
  }
}

/**
 * Whether `mergeRequests.comments` turns reviews and merge request comments off on `repo`:
 * `{ reason? }` when it does, `undefined` otherwise. Reads the settings on every call, so a change
 * in the panel applies to the next event or write.
 */
export async function commentsOffFor(
  store: Pick<Store, 'settings'>,
  config: HoltkeeperConfig,
  repo: RepoRef,
): Promise<{ reason?: string } | undefined> {
  const resolved = resolveMergeRequestComments(
    await store.settings.list(mergeRequestComments.key),
    repoTarget(config, repo),
  )
  if (resolved.enabled) return undefined
  return resolved.reason === undefined ? {} : { reason: resolved.reason }
}
