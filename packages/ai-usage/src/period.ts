/** A budget period, always in UTC. */
export type BudgetPeriod = 'day' | 'month'

/** The UTC day or month containing `now`: `[from, to)` and a key (`2026-10-30` / `2026-10`). */
export function periodRange(
  period: BudgetPeriod,
  now: Date,
): { from: string; to: string; key: string } {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  const start =
    period === 'day' ? Date.UTC(year, month, now.getUTCDate()) : Date.UTC(year, month, 1)
  const end =
    period === 'day' ? Date.UTC(year, month, now.getUTCDate() + 1) : Date.UTC(year, month + 1, 1)
  const from = new Date(start).toISOString()
  return { from, to: new Date(end).toISOString(), key: from.slice(0, period === 'day' ? 10 : 7) }
}

/** The month before the one containing `now`. */
export function previousMonth(now: Date): { from: string; to: string; key: string } {
  return periodRange('month', new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)))
}

/**
 * Linear projection of a month's spend to its end from what was spent so far. At the very start
 * of the month there is nothing to extrapolate from, so it returns `spent`.
 */
export function projectMonthEnd(spent: number, now: Date): number {
  const { from, to } = periodRange('month', now)
  const elapsed = now.getTime() - Date.parse(from)
  const total = Date.parse(to) - Date.parse(from)
  return elapsed <= 0 ? spent : (spent * total) / elapsed
}
