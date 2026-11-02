import { Cron } from 'croner'

import { type DigestSchedule, type Weekday, weekdays } from './model.ts'

const cronDay: Record<Weekday, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

/** The schedule as a cron expression (minute, hour, day of month, month, day of week). */
export function scheduleCron(schedule: DigestSchedule): string {
  const [hour = '0', minute = '0'] = schedule.time.split(':')
  const time = `${Number(minute)} ${Number(hour)}`
  if (schedule.every === 'month') return `${time} ${schedule.dayOfMonth} * *`
  const days =
    schedule.every === 'day' && schedule.days.length === weekdays.length
      ? '*'
      : weekdays
          .filter((day) => schedule.days.includes(day))
          .map((day) => cronDay[day])
          .join(',')
  return `${time} * * ${days}`
}

/** The first time the digest is due strictly after `after`, in its time zone. */
export function nextDigestRun(schedule: DigestSchedule, after: Date): Date | undefined {
  const cron = new Cron(scheduleCron(schedule), { paused: true, timezone: schedule.timezone })
  return cron.nextRun(after) ?? undefined
}

/** Whether a digest last run at `lastRun` (or created then) is due at `now`. */
export const digestDue = (schedule: DigestSchedule, lastRun: Date, now: Date): boolean => {
  const next = nextDigestRun(schedule, lastRun)
  return next !== undefined && next.getTime() <= now.getTime()
}

const dayNames: Record<Weekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
}

const suffixes: Record<number, string> = { 1: 'st', 2: 'nd', 3: 'rd' }

const ordinal = (day: number) =>
  day % 100 >= 11 && day % 100 <= 13 ? `${day}th` : `${day}${suffixes[day % 10] ?? 'th'}`

/** The schedule in words: `Every Monday at 10:00`, `Weekdays at 09:30`, `Monthly on the 1st at 08:00`. */
export function describeSchedule(schedule: DigestSchedule): string {
  const at = `at ${schedule.time}`
  if (schedule.every === 'month') return `Monthly on the ${ordinal(schedule.dayOfMonth)} ${at}`
  const days = weekdays.filter((day) => schedule.days.includes(day))
  if (days.length === weekdays.length) return `Every day ${at}`
  if (days.join() === 'mon,tue,wed,thu,fri') return `Weekdays ${at}`
  if (days.length === 1 && days[0]) return `Every ${dayNames[days[0]]} ${at}`
  return `Every ${days.map((day) => dayNames[day].slice(0, 3)).join(', ')} ${at}`
}
