import { describe, expect, test } from 'bun:test'

import {
  daysUntil,
  expiryTone,
  formatDuration,
  formatRef,
  formatRelative,
  isoDay,
  plural,
} from './format.ts'

const now = new Date('2026-10-29T12:00:00.000Z')

describe('formatRelative', () => {
  test('picks the largest fitting unit', () => {
    expect(formatRelative('2026-10-29T11:59:50.000Z', now)).toBe('just now')
    expect(formatRelative('2026-10-29T09:00:00.000Z', now)).toBe('3 hours ago')
    expect(formatRelative('2026-10-31T12:00:00.000Z', now)).toBe('in 2 days')
    expect(formatRelative('2026-10-28T12:00:00.000Z', now)).toBe('yesterday')
  })
})

describe('formatRef', () => {
  test('shortens full SHAs only', () => {
    expect(formatRef('28200925da86859b3f6b345d600856262b32945e')).toBe('28200925')
    expect(formatRef('main')).toBe('main')
    expect(formatRef('v1.2.0')).toBe('v1.2.0')
  })
})

describe('formatDuration', () => {
  test('scales units', () => {
    expect(formatDuration(850)).toBe('850 ms')
    expect(formatDuration(1240)).toBe('1.2 s')
    expect(formatDuration(42_000)).toBe('42 s')
    expect(formatDuration(185_000)).toBe('3 min 5 s')
    expect(formatDuration(120_000)).toBe('2 min')
    expect(formatDuration(7_800_000)).toBe('2 h 10 min')
    expect(formatDuration(-1)).toBe('—')
  })
})

describe('expiry', () => {
  test('days and tone', () => {
    expect(daysUntil('2026-11-08T12:00:00.000Z', now)).toBe(10)
    expect(expiryTone(undefined, now)).toBe('none')
    expect(expiryTone('2026-10-01T00:00:00.000Z', now)).toBe('expired')
    expect(expiryTone('2026-11-02T00:00:00.000Z', now)).toBe('soon')
    expect(expiryTone('2027-01-01T00:00:00.000Z', now)).toBe('ok')
  })
})

test('plural and isoDay', () => {
  expect(plural(1, 'finding')).toBe('1 finding')
  expect(plural(2, 'finding')).toBe('2 findings')
  expect(plural(0, 'entry', 'entries')).toBe('0 entries')
  expect(isoDay(now)).toBe('2026-10-29')
})
