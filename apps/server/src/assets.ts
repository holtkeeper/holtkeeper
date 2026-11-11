import type { RepoTarget, Scope } from '@holtkeeper/access'
import type { AssetsPolicySource, AssetsTrendPoint, RepoAssetsView } from '@holtkeeper/api'
import {
  type AssetsData,
  type AssetsPolicy,
  assetsDataSchema,
  assetsPolicyKey,
  assetsSummary,
  parseAssetsPolicy,
} from '@holtkeeper/assets'
import type { RepoRef } from '@holtkeeper/forge'
import { resolveSetting } from '@holtkeeper/settings'
import type { AnalysisRecord, Store } from '@holtkeeper/store'

import { LINE_SCAN, mainLineRecords } from './analyses.ts'

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
