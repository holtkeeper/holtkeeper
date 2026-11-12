import { expect, test } from 'bun:test'

import { callsByToken, errorRate, rankedRows, sparkHeights, usageBars } from './mcp-usage.ts'

test('usageBars scales answered and failed calls to the busiest day', () => {
  expect(
    usageBars([
      { date: '2026-01-01', calls: 10, errors: 2 },
      { date: '2026-01-02', calls: 5, errors: 0 },
      { date: '2026-01-03', calls: 0, errors: 0 },
    ]),
  ).toEqual([
    { date: '2026-01-01', answered: 8, failed: 2, answeredPct: 80, failedPct: 20 },
    { date: '2026-01-02', answered: 5, failed: 0, answeredPct: 50, failedPct: 0 },
    { date: '2026-01-03', answered: 0, failed: 0, answeredPct: 0, failedPct: 0 },
  ])
  expect(usageBars([{ date: '2026-01-01', calls: 0, errors: 0 }])[0]?.answeredPct).toBe(0)
})

test('rankedRows sorts, cuts and shares against the largest', () => {
  expect(
    rankedRows(
      [
        { name: 'b', calls: 2 },
        { name: 'a', calls: 8 },
        { name: 'c', calls: 1 },
      ],
      2,
    ),
  ).toEqual([
    { name: 'a', calls: 8, share: 1 },
    { name: 'b', calls: 2, share: 0.25 },
  ])
  expect(rankedRows([])).toEqual([])
})

test('sparkHeights keeps days with calls visible', () => {
  expect(sparkHeights([0, 1, 50, 100])).toEqual([0, 8, 50, 100])
  expect(sparkHeights([0, 0])).toEqual([0, 0])
})

test('errorRate', () => {
  expect(errorRate(0, 0)).toBe('—')
  expect(errorRate(200, 0)).toBe('0%')
  expect(errorRate(200, 9)).toBe('5%')
  expect(errorRate(2000, 1)).toBe('0.1%')
})

test('callsByToken', () => {
  expect(callsByToken([{ id: 't1', calls: 3 }]).get('t1')).toBe(3)
  expect(callsByToken().size).toBe(0)
})
