import { describe, expect, test } from 'bun:test'

import { formatDuration, percent, spread, weekOf, weeksOf } from './stats.ts'

describe('stats', () => {
  test('spread gives quartiles, p95 and max', () => {
    expect(spread([10, 20, 30, 40, 50])).toEqual({
      samples: 5,
      p25: 20,
      median: 30,
      p75: 40,
      p95: 48,
      max: 50,
    })
    expect(spread([])).toEqual({ samples: 0 })
  })

  test('percent is undefined without a whole', () => {
    expect(percent(1, 3)).toBe(33.3)
    expect(percent(1, 0)).toBeUndefined()
  })

  test('weeks start on Monday', () => {
    expect(weekOf('2026-07-05T23:00:00Z')).toBe('2026-06-29')
    expect(weeksOf('2026-07-01T00:00:00Z', '2026-07-14T00:00:00Z')).toEqual([
      '2026-06-29',
      '2026-07-06',
      '2026-07-13',
    ])
  })

  test('durations read like a person writes them', () => {
    expect(formatDuration(0.42)).toBe('0.4s')
    expect(formatDuration(42)).toBe('42s')
    expect(formatDuration(250)).toBe('4m 10s')
    expect(formatDuration(240)).toBe('4m')
    expect(formatDuration(3900)).toBe('1h 5m')
  })
})
