import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { RepoRef } from '@holtkeeper/forge'
import type { Job } from '@holtkeeper/store'

import type { ServerDeps } from './context.ts'
import { isReviewAnalyzer } from './mr-comments.ts'

/** A merge request of a repository. */
export interface MergeRequestTarget {
  repo: RepoRef
  mergeRequest: number
}

/**
 * Told whenever the review state of a merge request may have changed: a review was queued or
 * canceled, or a review job ended (stored, failed or blocked). It reads the current state
 * itself, so a call too many is harmless. Implementations never throw; the review pipeline
 * knows nothing about them.
 */
export interface MergeRequestStatusSink {
  reviewChanged(target: MergeRequestTarget): Promise<void>
}

/**
 * The merge request a job reviews: review analyzer jobs with a numeric `mergeRequest` option,
 * except thread replies (`replyTo`), which do not review the merge request again.
 */
export function reviewTargetOf(
  config: HoltkeeperConfig,
  job: Pick<Job, 'analyzer' | 'repo' | 'options'>,
): MergeRequestTarget | undefined {
  if (!isReviewAnalyzer(config, job.analyzer) || job.options.replyTo !== undefined) return undefined
  const mergeRequest = Number(job.options.mergeRequest)
  if (!Number.isInteger(mergeRequest) || mergeRequest <= 0) return undefined
  return { repo: job.repo, mergeRequest }
}

/**
 * Tells `deps.mergeRequestStatus` about a review job that was queued, canceled or ended, in the
 * background; jobs that review no merge request are ignored.
 */
export function noteReviewJob(
  deps: Pick<ServerDeps, 'config' | 'mergeRequestStatus' | 'onBackground'>,
  job: Pick<Job, 'analyzer' | 'repo' | 'options'>,
): void {
  const sink = deps.mergeRequestStatus
  const target = sink && reviewTargetOf(deps.config, job)
  if (!sink || !target) return
  const work = sink.reviewChanged(target).catch((error: unknown) => {
    console.error(`merge request status: ${error instanceof Error ? error.message : String(error)}`)
  })
  deps.onBackground?.(work)
}
