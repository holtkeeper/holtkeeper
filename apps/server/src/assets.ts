import type { RepoTarget, Scope } from '@holtkeeper/access'
import type {
  AssetsOverview,
  AssetsOverviewRow,
  AssetsPolicySource,
  AssetsQuery,
  AssetsRepoSummary,
  AssetsTrendPoint,
  RepoAssetsView,
} from '@holtkeeper/api'
import {
  type AssetRow,
  type AssetsData,
  type AssetsPolicy,
  assetsDataSchema,
  assetsPolicyKey,
  assetsSummary,
  parseAssetsMetrics,
  parseAssetsPolicy,
} from '@holtkeeper/assets'
import type { RepoRef } from '@holtkeeper/forge'
import { resolveSetting } from '@holtkeeper/settings'
import type { AnalysisHead, AnalysisRecord, Store } from '@holtkeeper/store'

import { LINE_SCAN, mainLineRecords } from './analyses.ts'
import { repoKey } from './context.ts'

/** Assets records the trend is drawn from. */
const TREND_RECORDS = 12

/** The asset policy that applies to a repository, with the scope of the entry it comes from. */
export interface EffectiveAssetsPolicy {
  policy: AssetsPolicy
  /** The winning `assets.policy` entry; unset when the default applies. */
  from?: { id: string; scope: Scope }
}

/** The `assets.policy` that applies to `target`: the most specific entry, else the default. */
export async function assetsPolicyFor(
  store: Pick<Store, 'settings'>,
  target: RepoTarget,
): Promise<EffectiveAssetsPolicy> {
  const entry = resolveSetting(await store.settings.list(assetsPolicyKey), assetsPolicyKey, target)
  if (!entry || entry.secret) return { policy: parseAssetsPolicy(undefined) }
  return { policy: parseAssetsPolicy(entry.value), from: { id: entry.id, scope: entry.scope } }
}

/**
 * The source of an effective policy as a caller may see it: the entry's id and scope only when
 * `canReadScope` allows that scope, otherwise just its level.
 */
export function assetsPolicySource(
  effective: EffectiveAssetsPolicy,
  canReadScope: (scope: Scope) => boolean,
): AssetsPolicySource {
  const from = effective.from
  if (!from) return { level: 'default' }
  const level = from.scope.all ? 'all' : from.scope.repos?.length ? 'repo' : 'group'
  return canReadScope(from.scope) ? { level, entry: from } : { level }
}

const dataOf = (record: AnalysisRecord): AssetsData | undefined => {
  const parsed = assetsDataSchema.safeParse(record.data)
  return parsed.success ? parsed.data : undefined
}

/**
 * The Assets tab of a repository: the effective policy, the newest assets record as a summary
 * and the total bytes and violations of recent records, oldest first. Reads stored records only;
 * the policy's entry is named only when `canReadScope` allows its scope.
 */
export async function repoAssetsView(
  store: Pick<Store, 'settings' | 'analyses'>,
  repo: RepoRef,
  target: RepoTarget,
  canReadScope: (scope: Scope) => boolean,
): Promise<RepoAssetsView> {
  const [effective, records] = await Promise.all([
    assetsPolicyFor(store, target),
    store.analyses.list({ repo, kind: 'assets', limit: LINE_SCAN }),
  ])
  const parsed = mainLineRecords(records, TREND_RECORDS).flatMap((record) => {
    const data = dataOf(record)
    return data ? [{ record, data }] : []
  })
  const latest = parsed[0]
  const trend: AssetsTrendPoint[] = parsed
    .map(({ record, data }) => ({
      at: record.createdAt,
      totalBytes: data.totals.reduce((sum, total) => sum + total.bytes, 0),
      violations: data.violations?.length ?? 0,
    }))
    .toSorted((a, b) => a.at.localeCompare(b.at))
  return {
    repo,
    policy: effective.policy,
    policySource: assetsPolicySource(effective, canReadScope),
    trend,
    ...(latest
      ? {
          analysisId: latest.record.id,
          createdAt: latest.record.createdAt,
          ...(latest.record.ref ? { ref: latest.record.ref } : {}),
          ...(latest.record.sha ? { sha: latest.record.sha } : {}),
          checkedPolicy: latest.data.policy !== undefined,
          summary: assetsSummary(latest.data),
        }
      : {}),
  }
}

/** Rows per page of `GET /api/assets` when the query names no limit. */
export const ASSETS_PAGE_DEFAULT = 50

/** Most rows one page of `GET /api/assets` returns, whatever the query asks for. */
export const ASSETS_PAGE_MAX = 200

/** What `assetsTable` computes once per filter set: every repository summary and every matching row in order. */
interface AssetsTable {
  repos: AssetsRepoSummary[]
  items: AssetsOverviewRow[]
}

/** The filters and order of `AssetsQuery`, without paging. */
type AssetsFilters = Omit<AssetsQuery, 'group' | 'repo' | 'cursor' | 'limit'>

const severityRank: Record<AssetRow['severity'], number> = { error: 0, warning: 1, info: 2 }
const policyProblem = (row: AssetRow) => row.problems.some((problem) => problem.severity !== 'info')
const savingOf = (row: AssetRow) => row.suggestion?.saving ?? 0

const matches = (row: AssetRow, filters: AssetsFilters) =>
  (filters.status === 'policy'
    ? policyProblem(row)
    : filters.status === 'saving'
      ? savingOf(row) > 0
      : true) &&
  (!filters.kind || row.kind === filters.kind) &&
  (!filters.problem || row.problems.some((problem) => problem.rule === filters.problem)) &&
  (!filters.format || row.format.toLowerCase() === filters.format.toLowerCase())

const orders: Record<NonNullable<AssetsQuery['sort']>, (a: AssetRow, b: AssetRow) => number> = {
  severity: (a, b) => severityRank[a.severity] - severityRank[b.severity] || b.bytes - a.bytes,
  saving: (a, b) => savingOf(b) - savingOf(a),
  size: (a, b) => b.bytes - a.bytes,
}

/**
 * The fleet Assets table over the given main-line `assets` heads (`latestHeadsWithMetrics`), from
 * their metrics only. Heads without metrics are left out. `repos` summarizes every repository;
 * `items` are the rows kept in the metrics (`AssetsMetrics.rows`) that match `filters`, in the
 * requested order, ties broken by repository and path.
 */
export function assetsTable(
  heads: readonly { head: AnalysisHead; target: RepoTarget }[],
  filters: AssetsFilters,
): AssetsTable {
  const repos: AssetsRepoSummary[] = []
  const items: AssetsOverviewRow[] = []
  for (const { head, target } of heads) {
    const metrics = parseAssetsMetrics(head.metrics)
    if (!metrics) continue
    repos.push({
      repo: head.repo,
      groups: target.groups,
      analysisId: head.id,
      createdAt: head.createdAt,
      files: metrics.files,
      bytes: metrics.bytes,
      kinds: metrics.kinds,
      errors: metrics.errors,
      warnings: metrics.warnings,
      budgets: metrics.budgets,
      savings: metrics.savings,
      duplicateBytes: metrics.duplicateBytes,
      ...(metrics.delta === undefined ? {} : { delta: metrics.delta }),
      moreRows: metrics.moreRows,
    })
    for (const row of metrics.rows)
      if (matches(row, filters)) items.push({ ...row, repo: head.repo, analysisId: head.id })
  }
  const order = orders[filters.sort ?? 'severity']
  return {
    repos: repos.toSorted(
      (a, b) => b.bytes - a.bytes || repoKey(a.repo).localeCompare(repoKey(b.repo)),
    ),
    items: items.toSorted(
      (a, b) =>
        order(a, b) ||
        repoKey(a.repo).localeCompare(repoKey(b.repo)) ||
        a.path.localeCompare(b.path),
    ),
  }
}

/**
 * One page of `table`: `limit` rows (at most `ASSETS_PAGE_MAX`) from `offset`, the total of
 * matching rows and the cursor of the next page while rows remain.
 */
export function assetsPage(table: AssetsTable, offset: number, limit: number): AssetsOverview {
  const size = Math.min(Math.max(1, limit), ASSETS_PAGE_MAX)
  const end = offset + size
  return {
    repos: table.repos,
    items: table.items.slice(offset, end),
    total: table.items.length,
    ...(end < table.items.length ? { nextCursor: String(end) } : {}),
  }
}
