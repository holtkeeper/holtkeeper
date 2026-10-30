import type { Distribution } from './types.ts'

const DAY_MS = 86_400_000

/** Linear-interpolated quantile (`q` from 0 to 1) of `values`; `undefined` when empty. */
export function quantile(values: readonly number[], q: number): number | undefined {
  if (values.length === 0) return undefined
  const sorted = values.toSorted((a, b) => a - b)
  const position = (sorted.length - 1) * Math.min(Math.max(q, 0), 1)
  const lower = Math.floor(position)
  const low = sorted[lower] ?? 0
  const high = sorted[Math.min(lower + 1, sorted.length - 1)] ?? low
  return low + (high - low) * (position - lower)
}

/** Median of `values`; `undefined` when empty. */
export const median = (values: readonly number[]) => quantile(values, 0.5)

/** Seconds from `from` to `to` (ISO 8601). */
export const secondsBetween = (from: string, to: string) =>
  (Date.parse(to) - Date.parse(from)) / 1000

/** Monday (UTC) of the week containing `at`, as `YYYY-MM-DD`. */
export function weekOf(at: string): string {
  const date = new Date(at)
  const day = (date.getUTCDay() + 6) % 7
  const monday =
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - day * DAY_MS
  return new Date(monday).toISOString().slice(0, 10)
}

/** Every week (see `weekOf`) touched by the window from `from` to `to`, oldest first. */
export function weeksOf(from: string, to: string): string[] {
  const weeks: string[] = []
  const end = weekOf(to)
  for (let week = weekOf(from); week <= end;) {
    weeks.push(week)
    week = new Date(Date.parse(week) + 7 * DAY_MS).toISOString().slice(0, 10)
  }
  return weeks
}

/** Whether `at` lies in the window `[from, to]` (ISO 8601, any offset). */
export function within(at: string | undefined, from: string, to: string): boolean {
  if (at === undefined) return false
  const time = Date.parse(at)
  return time >= Date.parse(from) && time <= Date.parse(to)
}

/** Orders ISO 8601 times chronologically, whatever their offsets. */
export const byTime = (a: string, b: string) => Date.parse(a) - Date.parse(b)

/** Rounds to `digits` decimals. */
export const round = (value: number, digits = 2) => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** `round`, passing `undefined` through. */
export const roundOptional = (value: number | undefined, digits = 2) =>
  value === undefined ? undefined : round(value, digits)

/** Counts `values` into labelled buckets by upper bound (exclusive); the last bound may be `Infinity`. */
export function bucketize(
  values: readonly number[],
  buckets: readonly { label: string; below: number }[],
): { label: string; count: number }[] {
  const counts = buckets.map((bucket) => ({ label: bucket.label, count: 0 }))
  for (const value of values) {
    const index = buckets.findIndex((bucket) => value < bucket.below)
    const target = counts[index === -1 ? counts.length - 1 : index]
    if (target) target.count++
  }
  return counts
}

/** `samples`, median, p90 and p95 of `values`. */
export function distribution(values: readonly number[]): Distribution {
  const result: Distribution = { samples: values.length }
  const mid = median(values)
  if (mid !== undefined) result.median = round(mid)
  const p90 = quantile(values, 0.9)
  if (p90 !== undefined) result.p90 = round(p90)
  const p95 = quantile(values, 0.95)
  if (p95 !== undefined) result.p95 = round(p95)
  return result
}
