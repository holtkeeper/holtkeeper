/** Calendar parts of a moment in a time zone, zero-padded. */
export function dateParts(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(at)
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ''
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    weekday: get('weekday').slice(0, 3).toLowerCase(),
  }
}

/** `at` in a date format of `YYYY`, `YY`, `MM`, `DD`, `HH` and `mm` tokens. */
export function formatDate(at: Date, format: string, timeZone: string): string {
  const parts = dateParts(at, timeZone)
  const values: Record<string, string> = {
    YYYY: parts.year,
    YY: parts.year.slice(2),
    MM: parts.month,
    DD: parts.day,
    HH: parts.hour,
    mm: parts.minute,
  }
  return format.replace(/YYYY|YY|MM|DD|HH|mm/gu, (token) => values[token] ?? token)
}

/**
 * Fills `{name}` placeholders from `values`; `{date}` is today as `YYYY-MM-DD` and `{date:<format>}`
 * any format of `formatDate`, both in `timeZone`. Unknown placeholders stay as written, so a
 * template with a typo shows it instead of losing text.
 */
export function fillTemplate(
  template: string,
  values: Record<string, string | undefined>,
  now: Date,
  timeZone: string,
): string {
  return template.replace(/\{(\w+)(?::([^}]+))?\}/gu, (whole, name: string, format?: string) => {
    if (name === 'date') return formatDate(now, format ?? 'YYYY-MM-DD', timeZone)
    const value = values[name]
    return value === undefined ? whole : value
  })
}
