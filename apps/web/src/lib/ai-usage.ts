import type { AiBudgetLimitView, AiUsageBucket, AiUsageTotals } from '@holtkeeper/api'
import { percentChange } from '@holtkeeper/api'

const usd = new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' })
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })

/** `$12.34`; `<$0.01` for tiny positive amounts. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value > 0 && value < 0.01) return '<$0.01'
  return usd.format(value)
}

/** `950`, `12.3K`, `4.5M`. */
export const formatTokens = (value: number): string =>
  Number.isFinite(value) ? compact.format(value) : '—'

/** `12.3%` of a 0..1 ratio. */
export const formatRatio = (ratio: number): string =>
  Number.isFinite(ratio) ? `${(ratio * 100).toFixed(ratio > 0 && ratio < 0.1 ? 1 : 0)}%` : '—'

/** Every token a run consumed or produced, cache traffic included. */
export const totalTokens = (
  totals: Pick<
    AiUsageTotals,
    'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'
  >,
): number =>
  totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens

/** Change of a metric against the previous period, and whether that change is good. */
export interface PeriodDelta {
  /** Percent change; absent when the previous value was 0. */
  percent?: number
  direction: 'up' | 'down' | 'flat'
  tone: 'success' | 'danger' | 'default'
}

/** Compares this period's value with the previous one; `better` says which direction is good. */
export function periodDelta(
  current: number,
  previous: number,
  better: 'up' | 'down' = 'down',
): PeriodDelta {
  const percent = percentChange(previous, current)
  const direction = current > previous ? 'up' : current < previous ? 'down' : 'flat'
  const tone = direction === 'flat' ? 'default' : direction === better ? 'success' : 'danger'
  return percent === undefined ? { direction, tone } : { percent, direction, tone }
}

/** `+12% vs last month`, `new this month`, `same as last month`. */
export function formatDelta(delta: PeriodDelta): string {
  if (delta.direction === 'flat') return 'same as last month'
  if (delta.percent === undefined) return 'none last month'
  const sign = delta.percent > 0 ? '+' : ''
  return `${sign}${Math.round(delta.percent)}% vs last month`
}

/** One day of the cost chart. */
export interface DayPoint {
  /** `YYYY-MM-DD` (UTC) */
  day: string
  costUsd: number
  runs: number
  tokens: number
}

const dayMs = 24 * 3600 * 1000

/** Midnight UTC `days - 1` days before `now`: the start of a `days`-long window ending today. */
export function windowStart(days: number, now: Date = new Date()): string {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return new Date(today - (days - 1) * dayMs).toISOString()
}

/** One point per day of the window ending today, zero where no bucket has data. */
export function fillDays(
  buckets: AiUsageBucket[],
  days: number,
  now: Date = new Date(),
): DayPoint[] {
  const byDay = new Map(buckets.flatMap((b) => (b.key.day ? [[b.key.day, b] as const] : [])))
  const start = new Date(windowStart(days, now)).getTime()
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(start + index * dayMs).toISOString().slice(0, 10)
    const bucket = byDay.get(day)
    return {
      day,
      costUsd: bucket?.costUsd ?? 0,
      runs: bucket?.runs ?? 0,
      tokens: bucket ? totalTokens(bucket) : 0,
    }
  })
}

/** Health of a budget limit: over it, heading over it by month end or close, or fine. */
export function budgetTone(limit: AiBudgetLimitView): 'success' | 'warning' | 'danger' {
  if (limit.percent >= 100) return 'danger'
  if (limit.percent >= 80 || (limit.projectedUsd ?? 0) > limit.limitUsd) return 'warning'
  return 'success'
}

/** A named, costed entry for top lists. */
export interface CostItem {
  name: string
  costUsd: number
  runs: number
}

/** Top list entries from buckets grouped by one dimension; empty keys become `fallback`. */
export const costItems = (
  buckets: AiUsageBucket[],
  dimension: 'repo' | 'model' | 'taskKind',
  fallback = 'unknown',
): CostItem[] =>
  buckets.map((bucket) => ({
    name: bucket.key[dimension] || fallback,
    costUsd: bucket.costUsd,
    runs: bucket.runs,
  }))
