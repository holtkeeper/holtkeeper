import type { RepoTarget } from '@holtkeeper/access'
import { metricsOf } from '@holtkeeper/analyzer'
import type { BundleTargetRow, BundlesRepoRow } from '@holtkeeper/api'
import { type BundleTargetMetrics, bundleAnalysis, judgeTarget } from '@holtkeeper/bundles'
import type { AnalysisHead, SettingEntry } from '@holtkeeper/store'

import { bundleBudgetsFor } from './repo-health.ts'

/** Newest main-line records per repository `GET /api/bundles` reads, as heads (metrics only). */
export const OVERVIEW_RECORDS = 20

/** One target's row from the heads of one repository, newest first. */
function targetRow(
  name: string,
  line: readonly { head: AnalysisHead; targets: Map<string, BundleTargetMetrics> }[],
  budgets: Record<string, number> | undefined,
): BundleTargetRow | undefined {
  const points = line.flatMap(({ head, targets }) => {
    const target = targets.get(name)
    return target ? [{ head, target }] : []
  })
  const [newest] = points
  if (!newest) return undefined
  const { target, head } = newest
  const { budget, verdict } = judgeTarget(target, budgets)
  return {
    name,
    source: target.source,
    ...(target.version ? { version: target.version } : {}),
    status: target.status,
    ...(target.gzip === undefined ? {} : { gzip: target.gzip }),
    ...(target.initial === undefined ? {} : { initial: target.initial }),
    ...(target.delta === undefined ? {} : { delta: target.delta }),
    ...(budget === undefined ? {} : { budget }),
    ...(verdict ? { verdict } : {}),
    overBudget: verdict === 'over',
    series: points.toReversed().map((point) => ({
      analysisId: point.head.id,
      createdAt: point.head.createdAt,
      status: point.target.status,
      ...(point.target.gzip === undefined ? {} : { gzip: point.target.gzip }),
    })),
    analysisId: head.id,
    createdAt: head.createdAt,
  }
}

/**
 * A repository's row of `GET /api/bundles` from its main-line heads, newest first, with budgets
 * as its `analyzers.bundle` settings give them; undefined without a head.
 */
export function bundlesRow(
  target: RepoTarget,
  heads: readonly AnalysisHead[],
  settings: readonly SettingEntry[],
): BundlesRepoRow | undefined {
  const [newest] = heads
  if (!newest) return undefined
  const line = heads.map((head) => ({
    head,
    targets: new Map(
      (metricsOf(bundleAnalysis, head)?.targets ?? []).map((entry) => [entry.name, entry]),
    ),
  }))
  const budgets = bundleBudgetsFor(settings, target)
  const names = [...new Set(line.flatMap(({ targets }) => [...targets.keys()]))].toSorted()
  const targets = names.flatMap((name) => targetRow(name, line, budgets) ?? [])
  return {
    repo: { forge: target.forge, path: target.path },
    groups: [...target.groups],
    analysisId: newest.id,
    createdAt: newest.createdAt,
    ...(newest.ref ? { ref: newest.ref } : {}),
    targets,
    failed: targets.filter((row) => row.status === 'failed').length,
    overBudget: targets.filter((row) => row.overBudget).length,
    records: heads.length,
  }
}
