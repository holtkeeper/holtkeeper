import type { Spread } from './types.ts'

const DAY_MS = 86_400_000

/** Linear-interpolated quantile (`q` from 0 to 1) of ascending `sorted`; `undefined` when empty. */
function sortedQuantile(sorted: readonly number[], q: number): number | undefined {
  if (sorted.length === 0) return undefined
  const position = (sorted.length - 1) * q
  const lower = Math.floor(position)
  const low = sorted[lower] ?? 0
  const high = sorted[Math.min(lower + 1, sorted.length - 1)] ?? low
  return low + (high - low) * (position - lower)
}

/** Linear-interpolated quantile (`q` from 0 to 1) of `values`; `undefined` when empty. */
export const quantile = (values: readonly number[], q: number) =>
  sortedQuantile(
    values.toSorted((a, b) => a - b),
    Math.min(Math.max(q, 0), 1),
  )

/** Median of `values`; `undefined` when empty. */
export const median = (values: readonly number[]) => quantile(values, 0.5)

/** Rounds to `digits` decimals. */
export const round = (value: number, digits = 1) => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** `samples`, p25, median, p75, p95 and max of `values`, rounded to a tenth. */
export function spread(values: readonly number[]): Spread {
  const sorted = values.toSorted((a, b) => a - b)
  const result: Spread = { samples: sorted.length }
  const set = (key: Exclude<keyof Spread, 'samples'>, value: number | undefined) => {
    if (value !== undefined) result[key] = round(value)
  }
  set('p25', sortedQuantile(sorted, 0.25))
  set('median', sortedQuantile(sorted, 0.5))
  set('p75', sortedQuantile(sorted, 0.75))
  set('p95', sortedQuantile(sorted, 0.95))
  set('max', sorted.at(-1))
  return result
}

/** Percent of `part` in `whole`, rounded to a tenth; `undefined` when `whole` is 0. */
export const percent = (part: number, whole: number) =>
  whole === 0 ? undefined : round((part / whole) * 100)

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

/** `at` shifted by `days` (negative for earlier), as ISO 8601. */
export const addDays = (at: string, days: number) =>
  new Date(Date.parse(at) + days * DAY_MS).toISOString()

export function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const group = groups.get(k)
    if (group) group.push(item)
    else groups.set(k, [item])
  }
  return groups
}

/** `1h 5m`, `4m 10s`, `12s`, `0.4s`: a duration in seconds for text. */
export function formatDuration(seconds: number): string {
  if (seconds < 10) return `${round(seconds)}s`
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`
  return `${s}s`
}
