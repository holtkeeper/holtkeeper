import type {
  AiBudgetStatus,
  AiForecastDay,
  AiUsageBucket,
  AiUsagePeriodKind,
  AiUsageRecord,
  AiUsageTotals,
  PersonView,
} from '@holtkeeper/api'
import { percentChange } from '@holtkeeper/api'

import { shortId } from './format.ts'

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

/** `+12% vs last week`, `none last week`, `same as last week`; `than` names the earlier span. */
export function formatDelta(delta: PeriodDelta, than = 'last week'): string {
  if (delta.direction === 'flat') return `same as ${than}`
  if (delta.percent === undefined) return `none ${than}`
  const sign = delta.percent > 0 ? '+' : ''
  return `${sign}${Math.round(delta.percent)}% vs ${than}`
}

/** How the overview's comparison span reads for each period. */
export const comparisonLabel: Record<AiUsagePeriodKind, string> = {
  week: 'last week',
  month: 'last month',
  '30d': 'the 30 days before',
}

type BudgetNumbers = Pick<
  AiBudgetStatus,
  'weeklyUsd' | 'reserveUsd' | 'warnPercent' | 'spentUsd' | 'forecastUsd'
>

const warnAt = (budget: Pick<AiBudgetStatus, 'weeklyUsd' | 'warnPercent'>) =>
  (budget.weeklyUsd * budget.warnPercent) / 100

/** Spend at which automatic work stops: the weekly limit minus the reserve, never below 0. */
export const automaticLimit = (budget: Pick<AiBudgetStatus, 'weeklyUsd' | 'reserveUsd'>) =>
  Math.max(budget.weeklyUsd - budget.reserveUsd, 0)

/**
 * Health of a weekly budget: the week's limit is used up, spend already reached where automatic
 * work stops or the budget's warn share, or the forecast says automatic work stops this week, or
 * fine.
 */
export function budgetTone(budget: BudgetNumbers): 'success' | 'warning' | 'danger' {
  if (budget.spentUsd >= budget.weeklyUsd) return 'danger'
  const limit = automaticLimit(budget)
  if (budget.spentUsd >= limit || budget.spentUsd >= warnAt(budget) || budget.forecastUsd > limit)
    return 'warning'
  return 'success'
}

/** Bar positions in percent of the weekly limit: spend, forecast and the reserve marker. */
export function budgetBar(budget: BudgetNumbers): {
  spent: number
  forecast: number
  reserve: number
} {
  const share = (amount: number) =>
    budget.weeklyUsd > 0 ? Math.min(100, Math.max(0, (amount / budget.weeklyUsd) * 100)) : 0
  return {
    spent: share(budget.spentUsd),
    forecast: share(budget.forecastUsd),
    reserve: share(automaticLimit(budget)),
  }
}

/** What a period is called in headings: `this week`, `this month`, `last 30 days`. */
export const periodLabel: Record<AiUsagePeriodKind, string> = {
  week: 'this week',
  month: 'this month',
  '30d': 'last 30 days',
}

/** A named, costed row of a breakdown. */
export interface CostItem {
  name: string
  costUsd: number
  runs: number
  /** Runs whose cost is unknown. */
  unknownCost: number
}

const byCostDesc = (a: CostItem, b: CostItem) => b.costUsd - a.costUsd || b.runs - a.runs

/** Breakdown rows from buckets grouped by one dimension, most expensive first; empty keys become `fallback`. */
export const costItems = (
  buckets: readonly AiUsageBucket[],
  dimension: 'repo' | 'model',
  fallback = 'unknown',
): CostItem[] =>
  buckets
    .map((bucket) => ({
      name: bucket.key[dimension] || fallback,
      costUsd: bucket.costUsd,
      runs: bucket.runs,
      unknownCost: bucket.unknownCost,
    }))
    .toSorted(byCostDesc)

/** The first `limit` items, and the rest summed with how many there were; no rest when nothing is left. */
export function topWithRest(
  items: readonly CostItem[],
  limit: number,
): { top: CostItem[]; rest?: CostItem & { count: number } } {
  if (items.length <= limit) return { top: [...items] }
  const tail = items.slice(limit)
  return {
    top: items.slice(0, limit),
    rest: {
      name: `${tail.length} more`,
      count: tail.length,
      costUsd: tail.reduce((sum, item) => sum + item.costUsd, 0),
      runs: tail.reduce((sum, item) => sum + item.runs, 0),
      unknownCost: tail.reduce((sum, item) => sum + item.unknownCost, 0),
    },
  }
}

const dayMs = 24 * 3600 * 1000

/** Days in the daily chart: four Monday-to-Sunday weeks, the current one last. */
export const chartDays = 28

/** Midnight UTC of the Monday three weeks before the current UTC week: where the daily chart starts. */
export function chartStart(now: Date = new Date()): string {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const sinceMonday = (now.getUTCDay() + 6) % 7
  return new Date(today - (sinceMonday + 21) * dayMs).toISOString()
}

/** One day of the daily chart, split by who started the work. */
export interface OriginDay {
  /** `YYYY-MM-DD` (UTC) */
  day: string
  people: number
  automatic: number
  /** Expected spend of what is left of the day (`AiSpendForecast.days`); 0 for past days. */
  forecast: number
  /** The day has not started yet. */
  future: boolean
  today: boolean
}

/**
 * One entry per chart day from buckets grouped by `day,origin`, zero where nothing ran, with the
 * forecast on today and the days after it. `forecast` lists consecutive local days of the instance
 * time zone starting with its today, so its first entry lands on the chart's (UTC) today whatever
 * its date and each later one a day further; entries past the chart's last day are not drawn.
 */
export function originDays(
  buckets: readonly AiUsageBucket[],
  start: string,
  now: Date = new Date(),
  days = chartDays,
  forecast: readonly AiForecastDay[] = [],
): OriginDay[] {
  const today = now.toISOString().slice(0, 10)
  const first = new Date(start).getTime()
  const todayIndex = Math.round((Date.parse(today) - first) / dayMs)
  const list: OriginDay[] = Array.from({ length: days }, (_, index) => {
    const day = new Date(first + index * dayMs).toISOString().slice(0, 10)
    return {
      day,
      people: 0,
      automatic: 0,
      forecast: index >= todayIndex ? (forecast[index - todayIndex]?.usd ?? 0) : 0,
      future: day > today,
      today: day === today,
    }
  })
  const byDay = new Map(list.map((entry) => [entry.day, entry]))
  for (const bucket of buckets) {
    const entry = bucket.key.day ? byDay.get(bucket.key.day) : undefined
    if (!entry) continue
    if (bucket.key.origin === 'interactive') entry.people += bucket.costUsd
    else entry.automatic += bucket.costUsd
  }
  return list
}

/** A round top for a chart axis at or above `value`, with its grid step (3 to 5 lines). */
export function niceScale(value: number): { max: number; step: number } {
  if (!(value > 0)) return { max: 1, step: 0.25 }
  const raw = value / 4
  const power = 10 ** Math.floor(Math.log10(raw))
  const step = ([1, 2, 2.5, 5, 10].find((f) => f * power >= raw) ?? 10) * power
  return { max: Math.ceil(value / step) * step, step }
}

/** Where a weekly budget stands, as a tone and words that say the same. */
export function budgetState(budget: BudgetNumbers): {
  tone: 'success' | 'warning' | 'danger'
  label: string
} {
  const limit = automaticLimit(budget)
  if (budget.spentUsd >= budget.weeklyUsd) return { tone: 'danger', label: 'Limit reached' }
  if (budget.reserveUsd > 0 && budget.spentUsd >= limit)
    return { tone: 'warning', label: 'Automatic work stopped' }
  if (budget.spentUsd >= warnAt(budget) || budget.forecastUsd > limit)
    return { tone: 'warning', label: 'Close to the limit' }
  return { tone: 'success', label: 'On track' }
}

/** `4d 13h`, `5h 20m`, `12m` until `to`; `now` once it passed. */
export function untilLabel(to: string, now: Date = new Date()): string {
  const minutes = Math.floor((new Date(to).getTime() - now.getTime()) / 60_000)
  if (minutes <= 0) return 'now'
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days) return `${days}d ${hours}h`
  if (hours) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}

/** The weekly budget form as typed. */
export interface BudgetDraft {
  weeklyUsd: string
  reserveUsd: string
  warnPercent: string
  action: 'block' | 'warn'
}

/** The form filled from a budget. */
export const budgetDraft = (
  budget: Pick<AiBudgetStatus, 'weeklyUsd' | 'reserveUsd' | 'warnPercent' | 'action'>,
): BudgetDraft => ({
  weeklyUsd: budget.weeklyUsd.toFixed(2),
  reserveUsd: budget.reserveUsd.toFixed(2),
  warnPercent: String(budget.warnPercent),
  action: budget.action,
})

const amount = (text: string) => {
  const trimmed = text.trim().replace(/^\$/, '').replaceAll(',', '')
  return trimmed === '' ? Number.NaN : Number(trimmed)
}

/** An `llm.budget` value from the form, or why it cannot be saved. */
export function parseBudgetDraft(draft: BudgetDraft):
  | {
      value: {
        weeklyUsd: number
        reserveUsd: number
        warnPercent: number
        action: 'block' | 'warn'
      }
    }
  | { error: string } {
  const weeklyUsd = amount(draft.weeklyUsd)
  const reserveUsd = amount(draft.reserveUsd)
  if (!Number.isFinite(weeklyUsd) || weeklyUsd <= 0)
    return { error: 'The weekly limit must be more than $0.' }
  if (!Number.isFinite(reserveUsd) || reserveUsd < 0)
    return { error: 'The amount kept for people must be $0 or more.' }
  if (reserveUsd > weeklyUsd)
    return { error: 'The amount kept for people cannot be more than the weekly limit.' }
  const warnPercent = amount(draft.warnPercent.replace(/%$/, ''))
  if (!Number.isInteger(warnPercent) || warnPercent < 1 || warnPercent > 100)
    return { error: 'Warn at must be a whole percent from 1 to 100.' }
  return { value: { weeklyUsd, reserveUsd, warnPercent, action: draft.action } }
}

/** A run's token counts in a few words: turns and cache share for agents, input and output otherwise. */
export function tokensNote(
  run: Pick<
    AiUsageRecord,
    'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'turns' | 'outcome'
  >,
): string {
  if (run.outcome === 'denied-budget' && totalTokens(run) === 0) return 'not sent'
  const input = run.inputTokens + run.cacheReadTokens + run.cacheWriteTokens
  if (run.turns > 1) {
    const cached = input > 0 ? Math.round((run.cacheReadTokens / input) * 100) : 0
    return `${run.turns} turns · ${cached}% cached`
  }
  return `${formatTokens(input)} in · ${formatTokens(run.outputTokens)} out`
}

/** What started a run: its job, its analysis, a person (named, else by short id) or the system. */
export type RunStarter =
  | { kind: 'job'; id: string }
  | { kind: 'analysis'; id: string }
  | { kind: 'person'; actor: string; name: string }
  | { kind: 'system'; actor: string }

/**
 * Where a run's "Started by" points: the job wins over the analysis, then who ran it. A person is
 * named from `people` (`AiRunList.people`), else shown by the short form of their id.
 */
export function runStarter(
  run: Pick<AiUsageRecord, 'jobId' | 'analysisId' | 'actor' | 'interactive'>,
  people: Readonly<Record<string, PersonView>> = {},
): RunStarter {
  if (run.jobId) return { kind: 'job', id: run.jobId }
  if (run.analysisId) return { kind: 'analysis', id: run.analysisId }
  return run.interactive
    ? { kind: 'person', actor: run.actor, name: people[run.actor]?.name ?? shortId(run.actor) }
    : { kind: 'system', actor: run.actor }
}
