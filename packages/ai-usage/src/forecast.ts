import type { AiUsageFilter, AiUsageStore } from '@holtkeeper/store'

import type { Budget } from './budget.ts'
import { type PeriodRange, instanceTimeZone, previousWeek, weekDays, weekRange } from './period.ts'

/** Full past weeks a forecast averages. */
const FORECAST_WEEKS = 4

const WEEK_MS = 7 * 86_400_000

/** Expected spend of one remaining day of a budget week. */
export interface ForecastDay {
  /** Local date in the forecast's time zone, `YYYY-MM-DD`. */
  day: string
  /** Expected spend from now (today) or local midnight (later days) to the next local midnight. */
  usd: number
  /** Part of `usd` expected from automatic work. */
  automaticUsd: number
}

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
  /**
   * With `perDay`: the rest of the week split by day, today first. Their `usd` sum to
   * `forecastUsd - spentUsd` and their `automaticUsd` to `automaticForecastUsd - automaticUsd`.
   */
  days?: ForecastDay[]
}

interface SpendForecastOptions {
  /** Which usage counts, e.g. `{ scopes: [budget.scope] }`. Default everything. */
  filter?: AiUsageFilter
  /** Where weeks start on Monday 00:00. Default: the instance time zone. */
  timeZone?: string
  /** Also split the rest of the week by day (`days`); costs one query per remaining day and week. */
  perDay?: boolean
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

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)

const iso = (time: number) => new Date(time).toISOString()

/**
 * The rest of `week` from `restFrom` on: one span to the week end, or with `perDay` one per local
 * day, the first starting at `restFrom` (kept inside the day `today` indexes).
 */
function restSpans(
  week: PeriodRange,
  restFrom: number,
  today: number,
  perDay: boolean,
  timeZone: string,
): PeriodRange[] {
  if (!perDay) return [{ from: iso(restFrom), to: week.to, key: week.key }]
  const [first, ...later] = weekDays(week, timeZone).slice(today)
  if (!first) return []
  const from = Math.min(Math.max(restFrom, Date.parse(first.from)), Date.parse(first.to))
  return [{ ...first, from: iso(from) }, ...later]
}

/**
 * This budget week's spend so far and where it is heading: for the rest of the week, the mean
 * spend of the same remaining span (same weekday and time to Monday 00:00) over the last
 * `FORECAST_WEEKS` full weeks. Weeks before the first week with matching usage are not averaged,
 * so a new instance is not diluted by empty weeks; with no such week the pace so far is extended to
 * the end of the week (as if at least one day had passed), spread over the remaining days by their
 * length.
 */
export async function spendForecast(
  usage: Usage,
  now: Date,
  { filter = {}, timeZone = instanceTimeZone(), perDay = false }: SpendForecastOptions = {},
): Promise<SpendForecast> {
  const week = weekRange(now, timeZone)
  const elapsed = Math.max(now.getTime() - Date.parse(week.from), 0)
  const today = Math.max(
    weekDays(week, timeZone).findIndex((day) => now.getTime() < Date.parse(day.to)),
    0,
  )
  const ahead = restSpans(week, now.getTime(), today, perDay, timeZone)
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
        const restFrom = Math.min(Date.parse(range.from) + elapsed, Date.parse(range.to))
        const spans = restSpans(range, restFrom, today, perDay, timeZone)
        const [full, ...rest] = await Promise.all([
          costOf(usage, filter, range.from, range.to),
          ...spans.map((span) => costOf(usage, filter, span.from, span.to)),
        ])
        return { used: (full?.runs ?? 0) > 0, automaticUsd: full?.automaticUsd ?? 0, rest }
      }),
    ),
  ])
  const counted = history.slice(0, history.findLastIndex((entry) => entry.used) + 1)
  const base = { week, spentUsd: spent.costUsd, automaticUsd: spent.automaticUsd }
  const daysOf = (usd: readonly number[], automatic: readonly number[]) =>
    perDay
      ? {
          days: ahead.map((span, index) => ({
            day: span.key,
            usd: usd[index] ?? 0,
            automaticUsd: automatic[index] ?? 0,
          })),
        }
      : {}
  if (!counted.length) {
    const share = Math.min(Math.max(elapsed / WEEK_MS, 1 / 7), 1)
    const forecastUsd = spent.costUsd / share
    const automaticForecastUsd = spent.automaticUsd / share
    const lengths = ahead.map((span) => Date.parse(span.to) - Date.parse(span.from))
    const left = sum(lengths)
    const part = (total: number) =>
      lengths.map((length) => (left > 0 ? (total * length) / left : 0))
    return {
      ...base,
      forecastUsd,
      automaticForecastUsd,
      automaticWeeklyMeanUsd: automaticForecastUsd,
      weeks: 0,
      ...daysOf(part(forecastUsd - spent.costUsd), part(automaticForecastUsd - spent.automaticUsd)),
    }
  }
  const usd = ahead.map((_, index) => mean(counted.map((entry) => entry.rest[index]?.costUsd ?? 0)))
  const automatic = ahead.map((_, index) =>
    mean(counted.map((entry) => entry.rest[index]?.automaticUsd ?? 0)),
  )
  return {
    ...base,
    forecastUsd: spent.costUsd + sum(usd),
    automaticForecastUsd: spent.automaticUsd + sum(automatic),
    automaticWeeklyMeanUsd: mean(counted.map((entry) => entry.automaticUsd)),
    weeks: counted.length,
    ...daysOf(usd, automatic),
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
