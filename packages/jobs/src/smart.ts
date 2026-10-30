import type { ScheduleConfig } from '@holtkeeper/core'
import { Cron } from 'croner'

/** The timing part of a schedule: what `nextRuns` reads. `name` seeds the jitter. */
export type ScheduleTiming = Pick<
  ScheduleConfig,
  'cron' | 'every' | 'timezone' | 'windows' | 'jitterMinutes'
> & { name?: string }

type Windows = NonNullable<ScheduleTiming['windows']>
type Window = NonNullable<Windows['allow']>[number]

const MINUTE = 60_000
const DAY = 86_400_000
/** How far ahead `nextRuns` looks before giving up. */
const HORIZON_DAYS = 400
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

/** The zone of this process, used when neither the schedule nor the caller names one. */
export const systemTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

/** Milliseconds of an `every` interval such as `15m`, `6h` or `1d`; throws for other strings. */
export function everyMs(every: string): number {
  const match = /^([1-9]\d*)(m|h|d)$/.exec(every)
  if (!match) throw new Error(`invalid interval "${every}"`)
  const unit = match[2] === 'm' ? MINUTE : match[2] === 'h' ? 60 * MINUTE : DAY
  return Number(match[1]) * unit
}

interface Local {
  date: string
  /** Days since 1970-01-01 of the local date. */
  dayNumber: number
  /** 0 = Monday. */
  weekday: number
  minute: number
}

/** Local wall-clock reader for one zone; offsets are cached per quarter hour. */
function zone(timeZone: string) {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  })
  const offsets = new Map<number, number>()
  const offsetAt = (ms: number) => {
    const bucket = Math.floor(ms / (15 * MINUTE))
    const cached = offsets.get(bucket)
    if (cached !== undefined) return cached
    const at = bucket * 15 * MINUTE
    const parts: Record<string, number> = {}
    for (const part of format.formatToParts(at)) parts[part.type] = Number(part.value)
    const wall = Date.UTC(
      parts.year ?? 1970,
      (parts.month ?? 1) - 1,
      parts.day ?? 1,
      parts.hour ?? 0,
      parts.minute ?? 0,
    )
    const offset = wall - at
    offsets.set(bucket, offset)
    return offset
  }
  const local = (ms: number): Local => {
    const wall = new Date(ms + offsetAt(ms))
    const dayNumber = Math.floor(wall.getTime() / DAY)
    return {
      date: wall.toISOString().slice(0, 10),
      dayNumber,
      weekday: (wall.getUTCDay() + 6) % 7,
      minute: wall.getUTCHours() * 60 + wall.getUTCMinutes(),
    }
  }
  /** The first instant of the local day `dayNumber` (after the gap when midnight is skipped). */
  const dayStart = (dayNumber: number) => {
    const wall = dayNumber * DAY
    let guess = wall - offsetAt(wall)
    guess = wall - offsetAt(guess)
    while (local(guess).dayNumber < dayNumber) guess += 15 * MINUTE
    return guess
  }
  return { local, dayStart }
}

const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))

const inRange = (minute: number, from: string, to: string) => {
  const start = minutesOf(from)
  const end = minutesOf(to)
  return start < end ? minute >= start && minute < end : minute >= start || minute < end
}

const inWindow = (window: Window, at: Local) => {
  const start = minutesOf(window.from)
  const end = minutesOf(window.to)
  const today = window.days.includes(WEEKDAYS[at.weekday] ?? 'mon')
  if (start < end) return today && at.minute >= start && at.minute < end
  const yesterday = window.days.includes(WEEKDAYS[(at.weekday + 6) % 7] ?? 'mon')
  return (today && at.minute >= start) || (yesterday && at.minute < end)
}

const deniedDay = (windows: Windows, at: Local) =>
  (windows.holidays?.includes(at.date) ?? false) ||
  (windows.skipWeekends === true && at.weekday >= 5)

const allowedAt = (windows: Windows | undefined, at: Local) => {
  if (!windows) return true
  if (deniedDay(windows, at)) return false
  if (windows.skipNights && inRange(at.minute, windows.skipNights.from, windows.skipNights.to))
    return false
  if (windows.deny?.some((window) => inWindow(window, at))) return false
  if (windows.allow?.length) return windows.allow.some((window) => inWindow(window, at))
  return true
}

const ceilMinute = (ms: number) => Math.ceil(ms / MINUTE) * MINUTE

/** 32-bit FNV-1a, for jitter that stays the same for the same schedule and run. */
function hash(text: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const limit = (from: number) => from + HORIZON_DAYS * DAY

function evaluator(schedule: ScheduleTiming, fallbackZone: string | undefined) {
  const tz = zone(schedule.timezone ?? fallbackZone ?? systemTimeZone())
  const allowed = (ms: number) => allowedAt(schedule.windows, tz.local(ms))

  /** The first allowed minute at or after `ms`. */
  const nextAllowed = (ms: number): number | undefined => {
    const end = limit(ms)
    let at = ceilMinute(ms)
    while (at < end) {
      const local = tz.local(at)
      if (schedule.windows && deniedDay(schedule.windows, local)) {
        at = tz.dayStart(local.dayNumber + 1)
        continue
      }
      if (allowedAt(schedule.windows, local)) return at
      at += MINUTE
    }
    return undefined
  }

  function* cronRuns(expression: string, after: number) {
    const cron = new Cron(expression, {
      paused: true,
      timezone: schedule.timezone ?? fallbackZone ?? systemTimeZone(),
    })
    const end = limit(after)
    let cursor = after
    while (cursor < end) {
      const candidate = cron.nextRun(new Date(cursor))
      if (!candidate) return
      const shifted = nextAllowed(candidate.getTime())
      if (shifted === undefined) return
      yield shifted
      cursor = shifted
    }
  }

  function* intervalRuns(interval: number, after: number) {
    const start = tz.local(after).dayNumber
    for (let day = start; day < start + HORIZON_DAYS; day++) {
      const from = tz.dayStart(day)
      const to = tz.dayStart(day + 1)
      let segment: number | undefined
      for (let at = from; at < to; at += MINUTE) {
        if (!allowed(at)) {
          segment = undefined
          continue
        }
        segment ??= at
        if ((at - segment) % interval === 0 && at > after) yield at
      }
    }
  }

  function* dailyRuns(days: number, after: number) {
    const start = tz.local(after).dayNumber
    let last = after
    for (let day = start; day < start + HORIZON_DAYS * 2; day++) {
      if (day % days !== 0) continue
      const shifted = nextAllowed(tz.dayStart(day))
      if (shifted === undefined) return
      if (shifted > last) {
        last = shifted
        yield shifted
      }
    }
  }

  /** Base run times (before jitter), strictly increasing and strictly after `after`. */
  const baseRuns = (after: number): Iterable<number> => {
    if (schedule.cron !== undefined) return cronRuns(schedule.cron, after)
    if (schedule.every === undefined) return []
    const interval = everyMs(schedule.every)
    return interval >= DAY && interval % DAY === 0
      ? dailyRuns(interval / DAY, after)
      : intervalRuns(interval, after)
  }

  const jitter = (base: number) => {
    const spread = schedule.jitterMinutes ?? 0
    if (spread <= 0) return base
    const moved = base + (hash(`${schedule.name ?? ''}@${base}`) % (spread + 1)) * MINUTE
    return allowed(moved) ? moved : base
  }

  return { allowed, baseRuns, jitter }
}

export interface NextRunsOptions {
  /** Zone for schedules without `timezone`. Default: the process's zone. */
  timezone?: string
}

/**
 * The next `count` run times strictly after `from`, in order, honoring the schedule's time zone
 * (including DST changes) and windows. A `cron` run that falls into a denied minute moves to the
 * next allowed minute (runs collapsing onto the same minute count once). `every` runs start at
 * the first allowed minute of each allowed stretch of a local day and repeat every interval of
 * elapsed time while still allowed; whole-day intervals run at the first allowed minute of every
 * n-th local day. Jitter adds a stable 0..`jitterMinutes` delay per run, dropped when it would
 * leave the allowed time. Returns fewer runs when nothing is allowed within about 400 days.
 */
export function nextRuns(
  schedule: ScheduleTiming,
  from: Date,
  count: number,
  options: NextRunsOptions = {},
): Date[] {
  if (count <= 0) return []
  const { baseRuns, jitter } = evaluator(schedule, options.timezone)
  const after = from.getTime()
  const runs: number[] = []
  for (const base of baseRuns(after - (schedule.jitterMinutes ?? 0) * MINUTE)) {
    const at = jitter(base)
    if (at <= after || at <= (runs.at(-1) ?? -Infinity)) continue
    runs.push(at)
    if (runs.length >= count) break
  }
  return runs.map((ms) => new Date(ms))
}

/** Whether the schedule's windows allow running at `at` (minute precision). */
export function isAllowedAt(
  schedule: ScheduleTiming,
  at: Date,
  options: NextRunsOptions = {},
): boolean {
  return evaluator(schedule, options.timezone).allowed(Math.floor(at.getTime() / MINUTE) * MINUTE)
}

/**
 * End of the window a run starting at `at` may spread its jobs over: the end of the allowed
 * stretch it starts in, but never past the next run and never more than 24 hours.
 */
export function runWindowEnd(
  schedule: ScheduleTiming,
  at: Date,
  options: NextRunsOptions = {},
): Date {
  const { allowed } = evaluator(schedule, options.timezone)
  const next = nextRuns(schedule, at, 1, options)[0]?.getTime()
  const cap = Math.min(next ?? Infinity, at.getTime() + DAY)
  let end = ceilMinute(at.getTime() + 1)
  while (end < cap && allowed(end)) end += MINUTE
  return new Date(Math.min(end, cap))
}

/** Ready-made timings to spread into a schedule. */
export const schedulePresets = {
  /** Every `every` (default `1h`) inside working hours (default Monday to Friday, 09:00–18:00). */
  workHours: (
    options: {
      every?: string
      from?: string
      to?: string
      days?: Window['days']
    } = {},
  ): Pick<ScheduleTiming, 'every' | 'windows'> => ({
    every: options.every ?? '1h',
    windows: {
      allow: [
        {
          days: options.days ?? ['mon', 'tue', 'wed', 'thu', 'fri'],
          from: options.from ?? '09:00',
          to: options.to ?? '18:00',
        },
      ],
    },
  }),
  /** Once a night at `at` (default 03:00), on weekdays unless `weekends` is set. */
  nightly: (options: { at?: string; weekends?: boolean } = {}): Pick<ScheduleTiming, 'cron'> => {
    const [hour, minute] = (options.at ?? '03:00').split(':').map(Number)
    return { cron: `${minute ?? 0} ${hour ?? 3} * * ${options.weekends ? '*' : '1-5'}` }
  },
  /** Once a week on `day` (default Monday) at `at` (default 06:00). */
  weekly: (
    options: { day?: Window['days'][number]; at?: string } = {},
  ): Pick<ScheduleTiming, 'cron'> => {
    const [hour, minute] = (options.at ?? '06:00').split(':').map(Number)
    const day = (WEEKDAYS.indexOf(options.day ?? 'mon') + 1) % 7
    return { cron: `${minute ?? 0} ${hour ?? 6} * * ${day}` }
  },
}
