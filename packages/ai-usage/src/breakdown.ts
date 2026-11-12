import {
  type AiUsageBucket,
  type AiUsageDimension,
  type AiUsageFilter,
  type AiUsageStore,
  type AiUsageTotals,
  emptyAiUsageTotals,
} from '@holtkeeper/store'

import type { PeriodRange } from './period.ts'

/** One week's usage split the ways spend is explained: by task kind, analyzer and provider. */
export interface WeekBreakdown {
  week: PeriodRange
  totals: AiUsageTotals
  /** Most expensive first, as are the other lists. */
  byTaskKind: AiUsageBucket[]
  /** Runs without an analyzer share the bucket with an empty `analyzer` key. */
  byAnalyzer: AiUsageBucket[]
  byProvider: AiUsageBucket[]
}

/** Buckets most expensive first, the busier first among equals. */
export const byCost = (buckets: readonly AiUsageBucket[]): AiUsageBucket[] =>
  buckets.toSorted((a, b) => b.costUsd - a.costUsd || b.runs - a.runs)

/** Sums of the usage `filter` matches, all zero when nothing does. */
export async function usageTotals(
  usage: Pick<AiUsageStore, 'aggregate'>,
  filter: AiUsageFilter,
): Promise<AiUsageTotals> {
  const [bucket] = await usage.aggregate({ filter })
  if (!bucket) return emptyAiUsageTotals()
  const { key: _key, ...totals } = bucket
  return totals
}

/** The usage of `week` that `filter` matches, split by task kind, analyzer and provider. */
export async function weekBreakdown(
  usage: Pick<AiUsageStore, 'aggregate'>,
  week: PeriodRange,
  filter: AiUsageFilter = {},
): Promise<WeekBreakdown> {
  const within = { ...filter, from: week.from, to: week.to }
  const split = async (dimension: AiUsageDimension) =>
    byCost(await usage.aggregate({ groupBy: [dimension], filter: within }))
  const [totals, byTaskKind, byAnalyzer, byProvider] = await Promise.all([
    usageTotals(usage, within),
    split('taskKind'),
    split('analyzer'),
    split('provider'),
  ])
  return { week, totals, byTaskKind, byAnalyzer, byProvider }
}
