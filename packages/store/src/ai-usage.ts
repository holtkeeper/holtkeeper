import { scopeCoversRepo } from '@holtkeeper/access'

import type {
  AiUsageAggregateQuery,
  AiUsageBucket,
  AiUsageDimension,
  AiUsageFilter,
  AiUsageRecord,
  AiUsageStore,
  AiUsageTotals,
} from './types.ts'

const clone = <T>(value: T): T => structuredClone(value)

/** Every dimension `AiUsageStore.aggregate` can group by. */
export const aiUsageDimensions: readonly AiUsageDimension[] = [
  'day',
  'week',
  'month',
  'repo',
  'group',
  'model',
  'provider',
  'taskKind',
  'analyzer',
]

/** The Monday (UTC) starting the ISO week of a timestamp, as `YYYY-MM-DD`. */
export function weekStart(at: string): string {
  const day = new Date(`${at.slice(0, 10)}T00:00:00.000Z`)
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7))
  return day.toISOString().slice(0, 10)
}

const dimensionValue = (
  record: AiUsageRecord,
  dimension: Exclude<AiUsageDimension, 'group'>,
): string => {
  switch (dimension) {
    case 'day':
      return record.at.slice(0, 10)
    case 'week':
      return weekStart(record.at)
    case 'month':
      return record.at.slice(0, 7)
    case 'repo':
      return `${record.repo.forge}:${record.repo.path}`
    case 'analyzer':
      return record.analyzer ?? ''
    default:
      return record[dimension]
  }
}

/** Whether a record passes every given field of `filter`. */
export function matchesAiUsageFilter(record: AiUsageRecord, filter: AiUsageFilter = {}): boolean {
  const { from, to, repo, group, model, provider, taskKind, analyzer, outcome, scopes } = filter
  return (
    (from === undefined || record.at >= from) &&
    (to === undefined || record.at < to) &&
    (!repo || (record.repo.forge === repo.forge && record.repo.path === repo.path)) &&
    (group === undefined || record.groups.includes(group)) &&
    (model === undefined || record.model === model) &&
    (provider === undefined || record.provider === provider) &&
    (taskKind === undefined || record.taskKind === taskKind) &&
    (analyzer === undefined || record.analyzer === analyzer) &&
    (outcome === undefined || record.outcome === outcome) &&
    (scopes === undefined ||
      scopes.some((scope) => scopeCoversRepo(scope, { ...record.repo, groups: record.groups })))
  )
}

/** Totals with nothing counted. */
export const emptyAiUsageTotals = (): AiUsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  runs: 0,
  errors: 0,
  denied: 0,
  avgDurationMs: 0,
})

/** Groups records like `AiUsageStore.aggregate` does; the reference for every implementation. */
export function aggregateAiUsage(
  records: readonly AiUsageRecord[],
  groupBy: readonly AiUsageDimension[] = [],
): AiUsageBucket[] {
  const buckets = new Map<string, { bucket: AiUsageBucket; durations: number; timed: number }>()
  for (const record of records) {
    let keys: AiUsageBucket['key'][] = [{}]
    for (const dimension of groupBy) {
      const values =
        dimension === 'group'
          ? record.groups.length
            ? record.groups
            : ['']
          : [dimensionValue(record, dimension)]
      keys = keys.flatMap((key) => values.map((value) => ({ ...key, [dimension]: value })))
    }
    for (const key of keys) {
      const id = JSON.stringify(groupBy.map((dimension) => key[dimension]))
      let entry = buckets.get(id)
      if (!entry) {
        entry = { bucket: { key, ...emptyAiUsageTotals() }, durations: 0, timed: 0 }
        buckets.set(id, entry)
      }
      const { bucket } = entry
      bucket.inputTokens += record.inputTokens
      bucket.outputTokens += record.outputTokens
      bucket.cacheReadTokens += record.cacheReadTokens
      bucket.cacheWriteTokens += record.cacheWriteTokens
      bucket.costUsd += record.costUsd
      bucket.runs += 1
      if (record.outcome === 'error') bucket.errors += 1
      if (record.outcome === 'denied-budget') bucket.denied += 1
      else {
        entry.durations += record.durationMs
        entry.timed += 1
      }
    }
  }
  return sortAiUsageBuckets(
    [...buckets.values()].map(({ bucket, durations, timed }) => ({
      ...bucket,
      avgDurationMs: timed ? durations / timed : 0,
    })),
    groupBy,
  )
}

/** Orders buckets by their key values in `groupBy` order, comparing code units. */
export function sortAiUsageBuckets(
  buckets: AiUsageBucket[],
  groupBy: readonly AiUsageDimension[] = [],
): AiUsageBucket[] {
  return buckets.toSorted((a, b) => {
    for (const dimension of groupBy) {
      const x = a.key[dimension] ?? ''
      const y = b.key[dimension] ?? ''
      if (x !== y) return x < y ? -1 : 1
    }
    return 0
  })
}

/** The aggregate's filter with its `from`/`to` folded in: the later start and the earlier end win. */
export function aggregateFilter({ from, to, filter = {} }: AiUsageAggregateQuery): AiUsageFilter {
  const start = [from, filter.from]
    .filter((value) => value !== undefined)
    .toSorted()
    .at(-1)
  const end = [to, filter.to].filter((value) => value !== undefined).toSorted()[0]
  return {
    ...filter,
    ...(start !== undefined && { from: start }),
    ...(end !== undefined && { to: end }),
  }
}

/** An `AiUsageStore` in process memory. */
export function memoryAiUsage(): AiUsageStore {
  const records: AiUsageRecord[] = []
  const within = (query: AiUsageAggregateQuery) =>
    records.filter((record) => matchesAiUsageFilter(record, aggregateFilter(query)))
  return {
    async append(record) {
      const stored = { ...clone(record), id: crypto.randomUUID() }
      records.push(stored)
      return clone(stored)
    },
    async list({ before, limit = 50, ...filter } = {}) {
      return records
        .map((record, seq) => ({ record, seq }))
        .filter(
          ({ record }) =>
            matchesAiUsageFilter(record, filter) && (before === undefined || record.at < before),
        )
        .toSorted((a, b) => b.record.at.localeCompare(a.record.at) || b.seq - a.seq)
        .slice(0, limit)
        .map(({ record }) => clone(record))
    },
    async aggregate(query = {}) {
      return aggregateAiUsage(within(query), query.groupBy)
    },
  }
}
