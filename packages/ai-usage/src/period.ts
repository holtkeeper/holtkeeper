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

/** The month before the one containing `now`. */
export function previousMonth(now: Date): PeriodRange {
  return monthRange(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)))
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
 * Linear projection of a period's spend to its end from what was spent so far. At the very start
 * of the period there is nothing to extrapolate from, so it returns `spent`.
 */
export function projectPeriodEnd(spent: number, range: PeriodRange, now: Date): number {
  const elapsed = now.getTime() - Date.parse(range.from)
  const total = Date.parse(range.to) - Date.parse(range.from)
  return elapsed <= 0 ? spent : (spent * total) / elapsed
}
