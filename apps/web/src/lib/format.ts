const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
]

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

/** `3 hours ago`, `in 2 days`, `now`. */
export function formatRelative(at: string | Date, now: Date = new Date()): string {
  const seconds = Math.round((new Date(at).getTime() - now.getTime()) / 1000)
  if (Math.abs(seconds) < 30) return 'just now'
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size || unit === 'second') {
      return relative.format(Math.round(seconds / size), unit)
    }
  }
  return relative.format(seconds, 'second')
}

const dateTime = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })
const dateOnly = new Intl.DateTimeFormat('en', { dateStyle: 'medium' })

/** `Oct 29, 2026, 12:00 PM` in the viewer's time zone. */
export const formatDateTime = (at: string | Date): string => dateTime.format(new Date(at))

/** `Oct 29, 2026`. */
export const formatDate = (at: string | Date): string => dateOnly.format(new Date(at))

/** Compact duration: `850 ms`, `12.4 s`, `3 min 5 s`, `2 h 10 min`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    const rest = Math.round(seconds % 60)
    return rest ? `${minutes} min ${rest} s` : `${minutes} min`
  }
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

/** Duration between two timestamps. */
export const durationBetween = (from: string, to: string): string =>
  formatDuration(new Date(to).getTime() - new Date(from).getTime())

/** Whole days from `now` until `at`; negative when already past. */
export function daysUntil(at: string | Date, now: Date = new Date()): number {
  return Math.floor((new Date(at).getTime() - now.getTime()) / (24 * 3600 * 1000))
}

/** Tone of an expiry: past, within `soonDays`, or comfortably ahead. */
export function expiryTone(
  at: string | undefined,
  now: Date = new Date(),
  soonDays = 14,
): 'none' | 'expired' | 'soon' | 'ok' {
  if (!at) return 'none'
  const days = daysUntil(at, now)
  if (new Date(at).getTime() <= now.getTime()) return 'expired'
  return days < soonDays ? 'soon' : 'ok'
}

/** `1 finding`, `3 findings`. */
export const plural = (count: number, word: string, many = `${word}s`): string =>
  `${count} ${count === 1 ? word : many}`

/** `YYYY-MM-DD` of a timestamp in UTC, for date inputs and day buckets. */
export const isoDay = (at: string | Date): string => new Date(at).toISOString().slice(0, 10)
