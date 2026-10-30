import { describe, expect, test } from 'bun:test'

import {
  cellSortValue,
  cellText,
  compareSortValues,
  deltaTone,
  formatDelta,
  formatValue,
} from './units.ts'

describe('formatValue', () => {
  test('formats each unit', () => {
    expect(formatValue(1536, 'bytes')).toBe('1.5 kB')
    expect(formatValue(12.34, 'percent')).toBe('12.3%')
    expect(formatValue(850, 'ms')).toBe('850 ms')
    expect(formatValue(1500, 'ms')).toBe('1.5 s')
    expect(formatValue(250_000, 'ms')).toBe('4m 10s')
    expect(formatValue(240_000, 'ms')).toBe('4m')
    expect(formatValue(3_900_000, 'ms')).toBe('1h 5m')
    expect(formatValue(97_200_000, 'ms')).toBe('1d 3h')
    expect(formatValue(-90_000, 'ms')).toBe('-1m 30s')
    expect(formatValue(119_600, 'ms')).toBe('2m')
    expect(formatValue(1204)).toBe('1,204')
    expect(formatValue('1.2.3', 'version')).toBe('1.2.3')
    expect(formatValue(null)).toBe('—')
    expect(formatValue(Number.NaN)).toBe('—')
  })
})

describe('deltas', () => {
  test('signs and units', () => {
    expect(formatDelta(1536, 'bytes')).toBe('+1.5 kB')
    expect(formatDelta(-3)).toBe('−3')
    expect(formatDelta(0, 'bytes')).toBe('±0')
  })

  test('tone follows the better direction', () => {
    expect(deltaTone(100, 'down')).toBe('bad')
    expect(deltaTone(-100, 'down')).toBe('good')
    expect(deltaTone(5, 'up')).toBe('good')
    expect(deltaTone(-5, 'up')).toBe('bad')
    expect(deltaTone(5, undefined)).toBe('neutral')
    expect(deltaTone(0, 'up')).toBe('neutral')
    expect(deltaTone(undefined, 'up')).toBe('neutral')
  })
})

describe('cells', () => {
  test('text and sort values', () => {
    expect(cellText({ text: 'react', href: 'x' })).toBe('react')
    expect(cellText(2048, 'bytes')).toBe('2.0 kB')
    expect(cellText(true)).toBe('yes')
    expect(cellText(null)).toBe('')
    expect(cellSortValue({ text: '42' })).toBe(42)
    expect(cellSortValue({ text: '+23%', value: 23 })).toBe(23)
    expect(cellSortValue('B')).toBe('b')
    expect(
      ['v10', 2, 'v9', 1].map((v) => (typeof v === 'string' ? v : v)).toSorted(compareSortValues),
    ).toEqual([1, 2, 'v9', 'v10'])
  })
})
