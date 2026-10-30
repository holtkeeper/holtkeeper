import type { Metric, Unit } from './model.ts'

/** Percentage change from `before` to `after`; `undefined` when there is no baseline. */
export const percentChange = (before: number, after: number) =>
  before === 0 ? undefined : ((after - before) / before) * 100

/** A metric with its delta against the previous value, when there is one. */
export function metric(
  id: string,
  label: string,
  value: number,
  options: { unit?: Unit; previous?: number; better?: 'up' | 'down'; hint?: string } = {},
): Metric {
  const { unit = 'count', previous, better, hint } = options
  return {
    id,
    label,
    value,
    unit,
    ...(previous === undefined ? {} : { delta: value - previous }),
    ...(better ? { better } : {}),
    ...(hint ? { hint } : {}),
  }
}

const units = ['B', 'kB', 'MB', 'GB']

/** `1536` → `1.5 kB`. Shared so every report and client shows sizes the same way. */
export function formatBytes(bytes: number): string {
  const sign = bytes < 0 ? '-' : ''
  let value = Math.abs(bytes)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${sign}${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}
