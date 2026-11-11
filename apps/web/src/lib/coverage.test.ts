import { expect, test } from 'bun:test'

import {
  coverageFreshness,
  coverageTone,
  formatPercent,
  formatPoints,
  lineSegments,
  percentOf,
  pointsTone,
  sortCoverageCards,
  trendTicks,
} from './coverage.ts'

test('percent and tone follow the report thresholds', () => {
  expect(percentOf({ covered: 1, total: 4 })).toBe(25)
  expect(percentOf({ covered: 0, total: 0 })).toBeUndefined()
  expect([90, 80, 79.9, 50, 49, undefined].map(coverageTone)).toEqual([
    'success',
    'success',
    'warning',
    'warning',
    'danger',
    'default',
  ])
  expect(formatPercent(87.46)).toBe('87.5%')
  expect(formatPercent(undefined)).toBe('—')
})

test('points read as signed changes', () => {
  expect(formatPoints(2.46)).toBe('+2.5 pt')
  expect(formatPoints(-1)).toBe('−1 pt')
  expect(formatPoints(0.01)).toBe('')
  expect(formatPoints(undefined)).toBe('')
  expect([3, -3, 0].map(pointsTone)).toEqual(['success', 'danger', 'default'])
})

test('line segments split uncovered lines by whether a test loaded the file', () => {
  expect(
    lineSegments({
      lines: { covered: 60, total: 100 },
      files: 3,
      untested: 1,
      untestedLines: 25,
    }).map((segment) => [segment.tone, segment.value]),
  ).toEqual([
    ['success', 60],
    ['warning', 15],
    ['danger', 25],
  ])
})

test('trend ticks carry tone and label, skipping records without lines', () => {
  const ticks = trendTicks([
    { at: '2026-10-20T03:00:00.000Z', lines: 40 },
    { at: '2026-10-27T03:00:00.000Z' },
  ])
  expect(ticks.map((tick) => tick.tone)).toEqual(['danger', 'skipped'])
  expect(ticks[0]?.label).toContain('40%')
})

test('freshness goes by age first, then by the known head', () => {
  const now = new Date('2026-10-30T12:00:00.000Z')
  expect(coverageFreshness({ createdAt: '2026-10-29T00:00:00.000Z' }, now)).toBe('fresh')
  expect(coverageFreshness({ createdAt: '2026-10-29T00:00:00.000Z', head: 'abc' }, now)).toBe(
    'behind',
  )
  expect(coverageFreshness({ createdAt: '2026-10-15T00:00:00.000Z', head: 'abc' }, now)).toBe(
    'aging',
  )
  expect(coverageFreshness({ createdAt: '2026-09-01T00:00:00.000Z' }, now)).toBe('stale')
})

const card = (path: string, covered: number, total: number) => ({
  repo: { forge: 'work', path },
  totals: { lines: { covered, total }, files: 1, untested: 0, untestedLines: 0 },
})

test('cards sort lowest coverage first, empty ones last', () => {
  expect(
    sortCoverageCards([card('a', 9, 10), card('b', 0, 0), card('c', 1, 10), card('d', 9, 10)]).map(
      (c) => c.repo.path,
    ),
  ).toEqual(['c', 'a', 'd', 'b'])
})
