import { describe, expect, test } from 'bun:test'

import { formatBytes, formatRef, metric, percentChange } from './format.ts'

describe('format helpers', () => {
  test('shortens full commit SHAs only', () => {
    expect(formatRef('28200925da86859b3f6b345d600856262b32945e')).toBe('28200925')
    expect(formatRef('main')).toBe('main')
  })

  test('formats bytes', () => {
    expect([0, 512, 1536, 250 * 1024, 5 * 1024 ** 2, -2048].map(formatBytes)).toEqual([
      '0 B',
      '512 B',
      '1.5 kB',
      '250 kB',
      '5.0 MB',
      '-2.0 kB',
    ])
  })

  test('builds metrics with deltas', () => {
    expect(metric('size', 'Size', 120, { unit: 'bytes', previous: 100, better: 'down' })).toEqual({
      id: 'size',
      label: 'Size',
      value: 120,
      unit: 'bytes',
      delta: 20,
      better: 'down',
    })
    expect(metric('n', 'Commits', 3)).toEqual({
      id: 'n',
      label: 'Commits',
      value: 3,
      unit: 'count',
    })
  })

  test('computes percent changes', () => {
    expect(percentChange(100, 125)).toBe(25)
    expect(percentChange(0, 10)).toBeUndefined()
  })
})
