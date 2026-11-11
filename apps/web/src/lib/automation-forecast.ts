import type { AiBudgetStatus, AiUsageBucket } from '@holtkeeper/api'

import type { Segment } from '../ui/SegmentBar.tsx'
import { automaticLimit } from './ai-usage.ts'

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS

/** Monday (UTC) of the week `at` falls in, `YYYY-MM-DD`, as AI usage buckets key weeks. */
export function weekStart(at: Date): string {
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())
  const weekday = (new Date(day).getUTCDay() + 6) % 7
  return new Date(day - weekday * DAY_MS).toISOString().slice(0, 10)
}

/** The first day of usage history the forecast reads: `lookback` full weeks before this one. */
export const forecastFrom = (now: Date, lookback = 4): string =>
  new Date(Date.parse(`${weekStart(now)}T00:00:00.000Z`) - lookback * WEEK_MS).toISOString()

/** Expected weekly AI spend of automatic work, against the budget when one is known. */
export interface AutomaticForecast {
  /** Full past weeks the estimate averages; 0 when it projects this week instead. */
  weeks: number
  forecastUsd: number
  /** Automatic spend so far this week. */
  thisWeekUsd: number
  /** Expected weekly spend per analyzer, largest first. */
  byAnalyzer: { analyzer: string; weeklyUsd: number }[]
  budget?: Pick<AiBudgetStatus, 'weeklyUsd' | 'reserveUsd' | 'spentUsd'>
  /** `success` under 80% of what automatic work may spend, `warning` up to it, `danger` over. */
  tone: 'default' | 'success' | 'warning' | 'danger'
}

/**
 * A deterministic estimate of automatic AI spend per week from usage buckets grouped by `week`
 * and `analyzer`: runs an analyzer started count as automatic (chat and other interactive runs
 * have none). It averages the last `lookback` full weeks, counting only weeks since usage was
 * first recorded so a new instance is not diluted by empty weeks; with no full week yet it
 * projects this week's spend over the whole week. It is never below what this week already spent.
 */
export function forecastAutomaticSpend(
  buckets: readonly AiUsageBucket[],
  options: {
    now: Date
    budget?: Pick<AiBudgetStatus, 'weeklyUsd' | 'reserveUsd' | 'spentUsd'>
    lookback?: number
  },
): AutomaticForecast {
  const lookback = options.lookback ?? 4
  const current = weekStart(options.now)
  const currentMs = Date.parse(`${current}T00:00:00.000Z`)
  const recorded = buckets.map((bucket) => bucket.key.week).filter((week) => week !== undefined)
  const first = recorded.toSorted()[0]
  const past = Array.from({ length: lookback }, (_, index) =>
    new Date(currentMs - (index + 1) * WEEK_MS).toISOString().slice(0, 10),
  ).filter((week) => first !== undefined && week >= first)
  const automatic = buckets.filter((bucket) => (bucket.key.analyzer ?? '') !== '')
  const thisWeekUsd = automatic
    .filter((bucket) => bucket.key.week === current)
    .reduce((sum, bucket) => sum + bucket.costUsd, 0)

  const perAnalyzer = new Map<string, number>()
  if (past.length) {
    for (const bucket of automatic) {
      if (!bucket.key.week || !past.includes(bucket.key.week)) continue
      const analyzer = bucket.key.analyzer ?? ''
      perAnalyzer.set(analyzer, (perAnalyzer.get(analyzer) ?? 0) + bucket.costUsd / past.length)
    }
  } else {
    const elapsed = Math.min(Math.max((options.now.getTime() - currentMs) / WEEK_MS, 1 / 7), 1)
    for (const bucket of automatic) {
      if (bucket.key.week !== current) continue
      const analyzer = bucket.key.analyzer ?? ''
      perAnalyzer.set(analyzer, (perAnalyzer.get(analyzer) ?? 0) + bucket.costUsd / elapsed)
    }
  }
  const byAnalyzer = [...perAnalyzer.entries()]
    .map(([analyzer, weeklyUsd]) => ({ analyzer, weeklyUsd }))
    .toSorted((a, b) => b.weeklyUsd - a.weeklyUsd || a.analyzer.localeCompare(b.analyzer))
  const forecastUsd = Math.max(
    byAnalyzer.reduce((sum, row) => sum + row.weeklyUsd, 0),
    thisWeekUsd,
  )
  const limit = options.budget ? automaticLimit(options.budget) : undefined
  const tone =
    limit === undefined
      ? 'default'
      : forecastUsd > limit
        ? 'danger'
        : forecastUsd > limit * 0.8
          ? 'warning'
          : 'success'
  return {
    weeks: past.length,
    forecastUsd,
    thisWeekUsd,
    byAnalyzer,
    ...(options.budget && { budget: options.budget }),
    tone,
  }
}

const cents = (value: number) => Math.round(Math.max(value, 0) * 100) / 100

/**
 * Segments of the weekly budget bar: automatic spend so far, the rest of the automatic forecast,
 * then what other work spent this week; the bar's total is the weekly budget.
 */
export function forecastSegments(forecast: AutomaticForecast): Segment[] {
  const other = forecast.budget ? forecast.budget.spentUsd - forecast.thisWeekUsd : 0
  return [
    { value: cents(forecast.thisWeekUsd), tone: 'accent', label: 'USD automatic so far' },
    {
      value: cents(forecast.forecastUsd - forecast.thisWeekUsd),
      tone: forecast.tone === 'danger' ? 'danger' : 'info',
      label: 'USD automatic forecast',
    },
    { value: cents(other), tone: 'default', label: 'USD other work' },
  ]
}
