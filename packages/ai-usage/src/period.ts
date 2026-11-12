/** A half-open time range `[from, to)` with a short key naming it. */
export interface PeriodRange {
  from: string
  to: string
  key: string
}

/** The process's local IANA time zone, which is the instance time zone. */
export const instanceTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

/** The UTC month containing `now`, keyed `2026-10`. */
export function monthRange(now: Date): PeriodRange {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  const from = new Date(start).toISOString()
  return { from, to: new Date(end).toISOString(), key: from.slice(0, 7) }
}

const localParts = (at: number, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(at))
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0)
  return {
    year: part('year'),
    month: part('month') - 1,
    day: part('day'),
    hour: part('hour'),
    minute: part('minute'),
    second: part('second'),
  }
}

const offsetAt = (at: number, timeZone: string) => {
  const p = localParts(at, timeZone)
  return Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000
}

/** The instant local midnight starts on a calendar day in `timeZone`; overflowing days roll over. */
function localMidnight(year: number, month: number, day: number, timeZone: string): number {
  const wall = Date.UTC(year, month, day)
  const first = wall - offsetAt(wall, timeZone)
  return wall - offsetAt(first, timeZone)
}

/**
 * The week containing `now`, from Monday 00:00 to the next Monday 00:00 in `timeZone` (default
 * the instance time zone), keyed by that Monday's local date (`2026-11-09`).
 */
export function weekRange(now: Date, timeZone: string = instanceTimeZone()): PeriodRange {
  const local = localParts(now.getTime(), timeZone)
  const weekday = new Date(Date.UTC(local.year, local.month, local.day)).getUTCDay()
  const monday = local.day - ((weekday + 6) % 7)
  const start = localMidnight(local.year, local.month, monday, timeZone)
  const end = localMidnight(local.year, local.month, monday + 7, timeZone)
  return {
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    key: new Date(Date.UTC(local.year, local.month, monday)).toISOString().slice(0, 10),
  }
}

/**
 * The seven days of `week` (a `weekRange` in the same `timeZone`), each from local midnight to the
 * next, keyed by its local date (`2026-11-12`); together they cover the week exactly.
 */
export function weekDays(week: PeriodRange, timeZone: string = instanceTimeZone()): PeriodRange[] {
  const [year = 0, month = 1, day = 1] = week.key.split('-').map(Number)
  const starts = Array.from({ length: 8 }, (_, index) =>
    index === 0
      ? Date.parse(week.from)
      : index === 7
        ? Date.parse(week.to)
        : localMidnight(year, month - 1, day + index, timeZone),
  )
  return starts.slice(0, 7).map((start, index) => ({
    from: new Date(start).toISOString(),
    to: new Date(starts[index + 1] ?? start).toISOString(),
    key: new Date(Date.UTC(year, month - 1, day + index)).toISOString().slice(0, 10),
  }))
}

/** The week before `week` (a `weekRange`), in the same time zone. */
export const previousWeek = (week: PeriodRange, timeZone: string = instanceTimeZone()) =>
  weekRange(new Date(Date.parse(week.from) - 1), timeZone)

/** The spans usage overviews report: the budget week, the UTC month, the last 30 days. */
export type PeriodKind = 'week' | 'month' | '30d'

/** Every `PeriodKind`. */
export const periodKinds: readonly PeriodKind[] = ['week', 'month', '30d']

const DAY_MS = 86_400_000

/** A range of `elapsed` milliseconds from `from`, never past `end`. */
const span = (from: string, elapsed: number, end: string, key: string): PeriodRange => ({
  from,
  to: new Date(Math.min(Date.parse(from) + elapsed, Date.parse(end))).toISOString(),
  key,
})

/**
 * A period from its start to `now` and the same elapsed span of the period before: for `week`
 * Monday 00:00 (instance time zone) to now against Monday 00:00 to the same weekday and time last
 * week; for `month` the UTC month so far against the same days of the previous month (cut at its
 * end); for `30d` the last 30 days against the 30 days before. Keys: the Monday (`2026-11-09`), the
 * month (`2026-11`), or `30d:` with the span's last UTC day (`30d:2026-11-12`).
 */
export function periodSpans(
  kind: PeriodKind,
  now: Date,
  timeZone: string = instanceTimeZone(),
): { current: PeriodRange; comparison: PeriodRange } {
  const at = now.toISOString()
  if (kind === 'week' || kind === 'month') {
    const range = kind === 'week' ? weekRange(now, timeZone) : monthRange(now)
    const last =
      kind === 'week'
        ? previousWeek(range, timeZone)
        : monthRange(new Date(Date.parse(range.from) - 1))
    const elapsed = now.getTime() - Date.parse(range.from)
    return {
      current: { from: range.from, to: at, key: range.key },
      comparison: span(last.from, elapsed, last.to, last.key),
    }
  }
  const start = new Date(now.getTime() - 30 * DAY_MS)
  const before = new Date(start.getTime() - 30 * DAY_MS)
  return {
    current: { from: start.toISOString(), to: at, key: `30d:${at.slice(0, 10)}` },
    comparison: {
      from: before.toISOString(),
      to: start.toISOString(),
      key: `30d:${start.toISOString().slice(0, 10)}`,
    },
  }
}
