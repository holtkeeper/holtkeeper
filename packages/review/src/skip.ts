import type { MergeRequest } from '@holtkeeper/forge'

import type { ReviewData } from './schema.ts'

/**
 * `source:target` branch globs of merge requests that are not reviewed by default: release
 * candidates from an integration branch into the stable one, and back-merges the other way.
 * Their code was reviewed when it reached the integration branch.
 */
export const DEFAULT_RELEASE_BRANCHES: readonly string[] = [
  'develop:main',
  'develop:master',
  'dev:main',
  'dev:master',
  'development:main',
  'staging:main',
  'release/*:main',
  'release/*:master',
  'main:develop',
  'master:develop',
]

/** Whether `source → target` matches one of the `source:target` globs. */
export function isReleaseMergeRequest(
  mr: Pick<MergeRequest, 'sourceBranch' | 'targetBranch'>,
  pairs: readonly string[],
): boolean {
  return pairs.some((pair) => {
    const separator = pair.indexOf(':')
    if (separator <= 0 || separator === pair.length - 1) return false
    return (
      new Bun.Glob(pair.slice(0, separator)).match(mr.sourceBranch) &&
      new Bun.Glob(pair.slice(separator + 1)).match(mr.targetBranch)
    )
  })
}

/**
 * Why a merge request is not reviewed automatically, or `undefined` when it is: a release or
 * back-merge between the `releaseBranches`, or authored by Holtkeeper itself (`botUsername`,
 * compared case-insensitively) unless `reviewOwn` is set.
 */
export function skipReason(
  mr: Pick<MergeRequest, 'sourceBranch' | 'targetBranch' | 'author'>,
  options: { releaseBranches: readonly string[]; reviewOwn: boolean },
  botUsername?: string,
): string | undefined {
  if (isReleaseMergeRequest(mr, options.releaseBranches))
    return `release merge request ${mr.sourceBranch} → ${mr.targetBranch}`
  if (!options.reviewOwn && botUsername && mr.author.toLowerCase() === botUsername.toLowerCase())
    return `merge request by Holtkeeper (${mr.author})`
  return undefined
}

/** The stored data of a merge request that was not reviewed; nothing is posted for it. */
export function skippedReview(
  mr: Pick<MergeRequest, 'id' | 'title' | 'webUrl' | 'sourceBranch' | 'targetBranch' | 'author'> & {
    headSha: string
  },
  reason: string,
): ReviewData {
  return {
    mergeRequest: {
      id: mr.id,
      title: mr.title,
      webUrl: mr.webUrl,
      sourceBranch: mr.sourceBranch,
      targetBranch: mr.targetBranch,
      author: mr.author,
    },
    head: mr.headSha,
    mode: 'skipped',
    verdict: 'skipped',
    summary: `Not reviewed: ${reason}. Review it anyway with \`/holtkeeper review force=true\`.`,
    comments: [],
    threads: [],
    skipped: [],
    stats: {
      files: 0,
      changedLines: 0,
      dropped: { belowSeverity: 0, overLimit: 0, duplicates: 0, invalid: 0 },
    },
    approved: false,
    checks: [],
  }
}
