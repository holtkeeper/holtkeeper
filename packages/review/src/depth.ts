import type { FileScope } from './scope.ts'
import { DEFAULT_SIZE_THRESHOLDS, estimateReviewMinutes, sizedFiles } from './size.ts'

/** How thoroughly the agent reviews: `standard` (Sonnet), `deep` (Opus) or `auto` by size. */
export const reviewDepths = ['auto', 'standard', 'deep'] as const

export type ReviewDepth = (typeof reviewDepths)[number]

/** The default depth: large changes on the `deep` tier, the rest on `main`. */
export const DEFAULT_REVIEW_DEPTH: ReviewDepth = 'auto'

/**
 * The estimated review time from which `auto` picks the `deep` tier; the same as
 * `largeMinutes`, so a merge request the summary calls large gets the stronger model.
 */
export const DEFAULT_DEEP_FROM_MINUTES = DEFAULT_SIZE_THRESHOLDS.largeMinutes

/** The tier a review runs on and, for `auto`, the estimate it was picked by. */
export interface ResolvedDepth {
  deep: boolean
  /** The `combined` estimate of the files under review; set for `auto` only. */
  minutes?: number
}

/**
 * Resolves `depth` for the files this run reviews (in an incremental run only the new commits):
 * `standard` and `deep` as they are, `auto` deep when the deterministic `combined` estimate
 * (`estimateReviewMinutes` with the default effort, known before the agent runs) reaches
 * `deepFromMinutes`. Deterministic: the same files give the same tier.
 */
export function resolveReviewDepth(
  depth: ReviewDepth,
  files: readonly FileScope[],
  deepFromMinutes: number = DEFAULT_DEEP_FROM_MINUTES,
): ResolvedDepth {
  if (depth !== 'auto') return { deep: depth === 'deep' }
  const minutes = estimateReviewMinutes({ files: sizedFiles(files), model: 'combined' })
  return { deep: minutes >= deepFromMinutes, minutes }
}
