import { type Cell, type Tone, type Unit, formatBytes } from '@holtkeeper/api'

const integer = new Intl.NumberFormat('en')
const decimal = new Intl.NumberFormat('en', { maximumFractionDigits: 1 })

/** `850 ms`, `1.5 s`, `4m 10s`, `2h 5m`, `3d 4h`: the two largest parts of a duration. */
function formatMs(value: number): string {
  const sign = value < 0 ? '-' : ''
  const ms = Math.abs(value)
  if (ms < 1000) return `${sign}${integer.format(Math.round(ms))} ms`
  if (ms < 60_000) return `${sign}${decimal.format(ms / 1000)} s`
  const seconds = Math.round(ms / 1000)
  const parts: [number, string][] = [
    [Math.floor(seconds / 86_400), 'd'],
    [Math.floor(seconds / 3600) % 24, 'h'],
    [Math.floor(seconds / 60) % 60, 'm'],
    [seconds % 60, 's'],
  ]
  const first = parts.findIndex(([amount]) => amount > 0)
  const shown = parts
    .slice(first, first + 2)
    .filter(([amount]) => amount > 0)
    .map(([amount, suffix]) => `${amount}${suffix}`)
  return `${sign}${shown.join(' ')}`
}

/** A report value formatted for its unit: `1.5 kB`, `12.5%`, `850 ms`, `1,204`. */
export function formatValue(
  value: number | string | null | undefined,
  unit: Unit = 'count',
): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'string') return value
  if (!Number.isFinite(value)) return '—'
  switch (unit) {
    case 'bytes':
      return formatBytes(value)
    case 'percent':
      return `${decimal.format(value)}%`
    case 'ms':
      return formatMs(value)
    case 'count':
      return Number.isInteger(value) ? integer.format(value) : decimal.format(value)
    default:
      return String(value)
  }
}

/** A change with an explicit sign: `+1.5 kB`, `−3`, `±0`. */
export function formatDelta(delta: number, unit: Unit = 'count'): string {
  if (delta === 0) return '±0'
  const magnitude = formatValue(
    Math.abs(delta),
    unit === 'version' || unit === 'text' ? 'count' : unit,
  )
  return `${delta > 0 ? '+' : '−'}${magnitude}`
}

/** `good` when the change goes the `better` direction, `bad` against it, `neutral` otherwise. */
export function deltaTone(delta: number | undefined, better: 'up' | 'down' | undefined): Tone {
  if (delta === undefined || delta === 0 || !better) return 'neutral'
  return delta > 0 === (better === 'up') ? 'good' : 'bad'
}

/** CSS color for a report tone, theme-aware. */
export const toneColor: Record<Tone, string> = {
  neutral: 'var(--sev-unknown)',
  info: 'var(--series-1)',
  good: 'var(--success)',
  warning: 'var(--warning)',
  bad: 'var(--danger)',
}

/** Display text of a table cell. */
export function cellText(cell: Cell | undefined, unit?: Unit): string {
  if (cell === null || cell === undefined) return ''
  if (typeof cell === 'object') return cell.text
  if (typeof cell === 'boolean') return cell ? 'yes' : 'no'
  return typeof cell === 'number' ? formatValue(cell, unit) : cell
}

/** Value a cell sorts by: numbers stay numbers, everything else sorts as text. */
export function cellSortValue(cell: Cell | undefined): number | string {
  if (cell === null || cell === undefined) return ''
  if (typeof cell === 'number') return cell
  if (typeof cell === 'boolean') return cell ? 1 : 0
  if (typeof cell === 'object') {
    if (cell.value !== undefined) return cell.value
    const numeric = Number(cell.text)
    return cell.text !== '' && Number.isFinite(numeric) ? numeric : cell.text.toLowerCase()
  }
  return cell.toLowerCase()
}

/** Compares two sort values; numbers before text, then natural text order. */
export function compareSortValues(a: number | string, b: number | string): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'number') return -1
  if (typeof b === 'number') return 1
  return a.localeCompare(b, 'en', { numeric: true })
}
