import type { RepoTarget } from '@holtkeeper/access'
import type { BranchesOverview, BranchesRepoRow } from '@holtkeeper/api'
import { type BranchesMetrics, branchesMetricsSchema } from '@holtkeeper/branches'
import type { RepoRef } from '@holtkeeper/forge'
import type { AnalysisKind } from '@holtkeeper/report'
import type { AnalysisHead, AnalysisStore } from '@holtkeeper/store'

import { latestHeadsWithMetrics, mainLineRecords } from './analyses.ts'
import { repoKey } from './context.ts'
import type { FleetCache } from './fleet-cache.ts'

const KIND = 'branches'

/** Heads of one repository read to find the run before its newest. */
export const BRANCHES_PREVIOUS_SCAN = 10

/** Where `branchesOverview` reads from. */
export interface BranchesSource {
  analyses: Pick<AnalysisStore, 'latest' | 'latestHeads' | 'heads' | 'get'>
  // oxlint-disable-next-line typescript/no-explicit-any -- kinds differ in their data type
  kinds: ReadonlyMap<string, AnalysisKind<any, any>>
  targetOf: (repo: RepoRef) => RepoTarget
  cache?: FleetCache
}

const metricsOf = (head: Pick<AnalysisHead, 'metrics'> | undefined) =>
  head ? branchesMetricsSchema.safeParse(head.metrics).data : undefined

function rowOf(
  head: AnalysisHead,
  metrics: BranchesMetrics,
  previous: BranchesMetrics | undefined,
  target: RepoTarget,
): BranchesRepoRow {
  const branches = metrics.branches ?? []
  return {
    repo: head.repo,
    groups: target.groups,
    analysisId: head.id,
    createdAt: head.createdAt,
    defaultBranch: metrics.defaultBranch ?? '',
    staleDays: metrics.staleDays ?? 0,
    total: metrics.total,
    open: metrics.open,
    cleanup: metrics.cleanup,
    merged: metrics.merged,
    closed: metrics.closed,
    stale: metrics.stale,
    ...(metrics.oldestDays === undefined ? {} : { oldestDays: metrics.oldestDays }),
    ...(previous
      ? {
          delta: {
            total: metrics.total - previous.total,
            cleanup: metrics.cleanup - previous.cleanup,
            merged: metrics.merged - previous.merged,
            closed: metrics.closed - previous.closed,
            stale: metrics.stale - previous.stale,
          },
        }
      : {}),
    authors: metrics.authors ?? [],
    branches: branches.map(({ mergeRequest, ...branch }) => ({
      ...branch,
      ...(mergeRequest
        ? {
            mergeRequest: {
              iid: mergeRequest.id,
              state: mergeRequest.state,
              title: mergeRequest.title,
              url: mergeRequest.webUrl,
            },
          }
        : {}),
    })),
    more: Math.max(0, metrics.cleanup - branches.length),
  }
}

async function previousOf(source: BranchesSource, head: AnalysisHead) {
  const line = mainLineRecords(
    await source.analyses.heads({ repo: head.repo, kind: KIND, limit: BRANCHES_PREVIOUS_SCAN }),
    BRANCHES_PREVIOUS_SCAN,
  )
  const at = line.findIndex((entry) => entry.id === head.id)
  return at === -1 ? undefined : line[at + 1]
}

/**
 * The newest main-line `branches` record of every repository `canRead` allows, most to clean up
 * first: counts, authors and the oldest branches from its stored metrics, and the change of each
 * count against the run before it. Reads no record data except for newest records stored before
 * metrics existed (`latestHeadsWithMetrics`). With `source.cache`, answers are kept while the
 * newest records and the readable repositories stay the same.
 */
export async function branchesOverview(
  source: BranchesSource,
  canRead: (target: RepoTarget) => boolean,
): Promise<BranchesOverview> {
  const heads = (
    await latestHeadsWithMetrics(source.analyses, source.kinds, { kind: KIND })
  ).filter((head) => canRead(source.targetOf(head.repo)))
  const build = async (): Promise<BranchesOverview> => {
    const rows = await Promise.all(
      heads.map(async (head) => {
        const metrics = metricsOf(head)
        if (!metrics) return []
        const previous = metricsOf(await previousOf(source, head))
        return [rowOf(head, metrics, previous, source.targetOf(head.repo))]
      }),
    )
    return {
      repos: rows
        .flat()
        .toSorted(
          (a, b) => b.cleanup - a.cleanup || repoKey(a.repo).localeCompare(repoKey(b.repo)),
        ),
    }
  }
  if (!source.cache) return build()
  return source.cache.read(
    {
      endpoint: KIND,
      analysisIds: heads.map((head) => head.id),
      repos: heads.map((head) => repoKey(head.repo)),
    },
    build,
  )
}
