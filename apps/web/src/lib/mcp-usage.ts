import type { McpTokenUsage, McpUsageDay } from '@holtkeeper/api'

/** One day of the My usage chart, with heights in percent of the busiest day. */
export interface UsageBar {
  date: string
  answered: number
  failed: number
  answeredPct: number
  failedPct: number
}

/** Answered and failed calls per day, scaled so the busiest day fills the chart. */
export function usageBars(days: readonly McpUsageDay[]): UsageBar[] {
  const top = Math.max(0, ...days.map((day) => day.calls))
  const pct = (value: number) => (top ? (value / top) * 100 : 0)
  return days.map((day) => ({
    date: day.date,
    answered: day.calls - day.errors,
    failed: day.errors,
    answeredPct: pct(day.calls - day.errors),
    failedPct: pct(day.errors),
  }))
}

/** A ranked row with its share of the first row, for bar tracks. */
export interface RankedRow {
  name: string
  calls: number
  share: number
}

/** The first `size` rows, each with `calls` as a share (0–1) of the largest. */
export function rankedRows(
  rows: readonly { name: string; calls: number }[],
  size = 6,
): RankedRow[] {
  const top = Math.max(0, ...rows.map((row) => row.calls))
  return rows
    .toSorted((a, b) => b.calls - a.calls)
    .slice(0, size)
    .map((row) => ({ name: row.name, calls: row.calls, share: top ? row.calls / top : 0 }))
}

/** Daily calls as bar heights in percent of the busiest day; a day with calls is at least 8. */
export function sparkHeights(daily: readonly number[]): number[] {
  const top = Math.max(0, ...daily)
  return daily.map((calls) => (calls && top ? Math.max(8, Math.round((calls / top) * 100)) : 0))
}

/** Failed calls as a percent of all calls, `—` without calls. */
export const errorRate = (calls: number, errors: number): string =>
  calls ? `${((errors / calls) * 100).toFixed(errors && errors * 1000 < calls ? 1 : 0)}%` : '—'

/** Calls per token id. */
export const callsByToken = (tokens: readonly McpTokenUsage[] = []): Map<string, number> =>
  new Map(tokens.map((token) => [token.id, token.calls]))
