import type { AiUsageFilter, AiUsageStore } from '@holtkeeper/store'

import type { Budget } from './budget.ts'
import { type PeriodRange, instanceTimeZone, previousWeek, weekRange } from './period.ts'

/** Full past weeks a forecast averages. */
const FORECAST_WEEKS = 4

const WEEK_MS = 7 * 86_400_000

/** Where a budget week's spend is heading. */
export interface SpendForecast {
  week: PeriodRange
  /** Spend so far this week. */
  spentUsd: number
  /** Part of `spentUsd` automatic work spent. */
  automaticUsd: number
  /** Expected spend by the end of the week; never below `spentUsd`. */
  forecastUsd: number
  /** Expected automatic spend by the end of the week; never below `automaticUsd`. */
  automaticForecastUsd: number
  /** Mean automatic spend of a full week over the weeks averaged. */
  automaticWeeklyMeanUsd: number
  /** Full past weeks averaged, 0 to 4; 0 when the week's pace is extended instead. */
  weeks: number
}

interface SpendForecastOptions {
  /** Which usage counts, e.g. `{ scopes: [budget.scope] }`. Default everything. */
  filter?: AiUsageFilter
  /** Where weeks start on Monday 00:00. Default: the instance time zone. */
  timeZone?: string
}

type Usage = Pick<AiUsageStore, 'aggregate'>

/** Spend between `from` and `to`, in all and of automatic work, in one query. */
const costOf = async (usage: Usage, filter: AiUsageFilter, from: string, to: string) => {
  const buckets = await usage.aggregate({ from, to, filter, groupBy: ['origin'] })
  const automatic = buckets.find((bucket) => bucket.key.origin === 'automatic')
  return {
    costUsd: buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0),
    automaticUsd: automatic?.costUsd ?? 0,
    runs: buckets.reduce((sum, bucket) => sum + bucket.runs, 0),
  }
}

const mean = (values: readonly number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length

/**
 * This budget week's spend so far and where it is heading: for the rest of the week, the mean
 * spend of the same remaining span (same weekday and time to Monday 00:00) over the last
 * `FORECAST_WEEKS` full weeks. Weeks before the first week with matching usage are not averaged,
 * so a new instance is not diluted by empty weeks; with no such week the pace so far is extended to
 * the end of the week (as if at least one day had passed).
 */
export async function spendForecast(
  usage: Usage,
  now: Date,
  { filter = {}, timeZone = instanceTimeZone() }: SpendForecastOptions = {},
): Promise<SpendForecast> {
  const week = weekRange(now, timeZone)
  const elapsed = Math.max(now.getTime() - Date.parse(week.from), 0)
  const past: PeriodRange[] = []
  for (let last = week; past.length < FORECAST_WEEKS;) {
    last = previousWeek(last, timeZone)
    past.push(last)
  }
  const at = now.toISOString()
  const [spent, history] = await Promise.all([
    costOf(usage, filter, week.from, at),
    Promise.all(
      past.map(async (range) => {
        const rest = new Date(Math.min(Date.parse(range.from) + elapsed, Date.parse(range.to)))
        const [full, remaining] = await Promise.all([
          costOf(usage, filter, range.from, range.to),
          costOf(usage, filter, rest.toISOString(), range.to),
        ])
        return {
          used: full.runs > 0,
          automaticUsd: full.automaticUsd,
          restUsd: remaining.costUsd,
          restAutomaticUsd: remaining.automaticUsd,
        }
      }),
    ),
  ])
  const counted = history.slice(0, history.findLastIndex((entry) => entry.used) + 1)
  const base = { week, spentUsd: spent.costUsd, automaticUsd: spent.automaticUsd }
  if (!counted.length) {
    const share = Math.min(Math.max(elapsed / WEEK_MS, 1 / 7), 1)
    return {
      ...base,
      forecastUsd: spent.costUsd / share,
      automaticForecastUsd: spent.automaticUsd / share,
      automaticWeeklyMeanUsd: spent.automaticUsd / share,
      weeks: 0,
    }
  }
  return {
    ...base,
    forecastUsd: spent.costUsd + mean(counted.map((entry) => entry.restUsd)),
    automaticForecastUsd: spent.automaticUsd + mean(counted.map((entry) => entry.restAutomaticUsd)),
    automaticWeeklyMeanUsd: mean(counted.map((entry) => entry.automaticUsd)),
    weeks: counted.length,
  }
}

/**
 * When the week's spend is expected to reach what automatic work may spend (`weeklyUsd -
 * reserveUsd`), spreading the forecast's remaining spend evenly over the rest of the week. Absent
 * when the forecast stays at or below that, or spend already reached it (automatic work stopped).
 */
export function automaticStopsAt(
  budget: Pick<Budget, 'weeklyUsd' | 'reserveUsd'>,
  forecast: Pick<SpendForecast, 'week' | 'spentUsd' | 'forecastUsd'>,
  now: Date,
): string | undefined {
  const limit = Math.max(budget.weeklyUsd - budget.reserveUsd, 0)
  const left = Date.parse(forecast.week.to) - now.getTime()
  if (forecast.spentUsd >= limit || forecast.forecastUsd <= limit || left <= 0) return undefined
  const share = (limit - forecast.spentUsd) / (forecast.forecastUsd - forecast.spentUsd)
  return new Date(now.getTime() + Math.floor(left * share)).toISOString()
}
