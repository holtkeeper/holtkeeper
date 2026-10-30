import { describe, expect, test } from 'bun:test'

import type { AiUsageBucket } from '@holtkeeper/api'

import {
  budgetTone,
  costItems,
  fillDays,
  formatDelta,
  formatRatio,
  formatTokens,
  formatUsd,
  periodDelta,
  totalTokens,
  windowStart,
} from './ai-usage.ts'

const bucket = (key: AiUsageBucket['key'], costUsd: number, runs = 1): AiUsageBucket => ({
  key,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 20,
  cacheWriteTokens: 5,
  costUsd,
  runs,
  errors: 0,
  denied: 0,
  avgDurationMs: 0,
})

describe('formatting', () => {
  test('formats dollars', () => {
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(0.004)).toBe('<$0.01')
    expect(formatUsd(12.345)).toBe('$12.35')
    expect(formatUsd(1234.5)).toBe('$1,234.50')
    expect(formatUsd(Number.NaN)).toBe('—')
  })

  test('formats tokens compactly', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(12_300)).toBe('12.3K')
    expect(formatTokens(4_500_000)).toBe('4.5M')
  })

  test('formats ratios', () => {
    expect(formatRatio(0)).toBe('0%')
    expect(formatRatio(0.042)).toBe('4.2%')
    expect(formatRatio(0.5)).toBe('50%')
  })

  test('sums every token kind', () => {
    expect(totalTokens(bucket({}, 0))).toBe(175)
  })
})

describe('periodDelta', () => {
  test('rates cost growth as bad by default', () => {
    expect(periodDelta(150, 100)).toEqual({ percent: 50, direction: 'up', tone: 'danger' })
    expect(periodDelta(50, 100)).toEqual({ percent: -50, direction: 'down', tone: 'success' })
  })

  test('rates growth as good when asked', () => {
    expect(periodDelta(2, 1, 'up').tone).toBe('success')
  })

  test('handles a zero previous value and no change', () => {
    expect(periodDelta(5, 0)).toEqual({ direction: 'up', tone: 'danger' })
    expect(periodDelta(3, 3)).toEqual({ percent: 0, direction: 'flat', tone: 'default' })
  })

  test('describes the delta', () => {
    expect(formatDelta(periodDelta(150, 100))).toBe('+50% vs last month')
    expect(formatDelta(periodDelta(50, 100))).toBe('-50% vs last month')
    expect(formatDelta(periodDelta(5, 0))).toBe('none last month')
    expect(formatDelta(periodDelta(0, 0))).toBe('same as last month')
  })
})

describe('fillDays', () => {
  const now = new Date('2026-10-30T15:00:00Z')

  test('starts the window at midnight UTC', () => {
    expect(windowStart(30, now)).toBe('2026-10-01T00:00:00.000Z')
    expect(windowStart(1, now)).toBe('2026-10-30T00:00:00.000Z')
  })

  test('fills missing days with zeros', () => {
    const points = fillDays(
      [bucket({ day: '2026-10-28' }, 1.5, 3), bucket({ day: '2026-10-30' }, 2)],
      3,
      now,
    )
    expect(points).toEqual([
      { day: '2026-10-28', costUsd: 1.5, runs: 3, tokens: 175 },
      { day: '2026-10-29', costUsd: 0, runs: 0, tokens: 0 },
      { day: '2026-10-30', costUsd: 2, runs: 1, tokens: 175 },
    ])
  })

  test('ignores buckets outside the window or without a day', () => {
    const points = fillDays([bucket({ day: '2026-09-01' }, 9), bucket({}, 9)], 2, now)
    expect(points.map((p) => p.costUsd)).toEqual([0, 0])
  })
})

describe('budgetTone', () => {
  const limit = { period: 'month' as const, limitUsd: 100, spentUsd: 0, percent: 0 }

  test('rates spend against the limit', () => {
    expect(budgetTone({ ...limit, percent: 40 })).toBe('success')
    expect(budgetTone({ ...limit, percent: 85 })).toBe('warning')
    expect(budgetTone({ ...limit, percent: 100 })).toBe('danger')
  })

  test('warns when the projection exceeds the limit', () => {
    expect(budgetTone({ ...limit, percent: 40, projectedUsd: 120 })).toBe('warning')
  })
})

test('costItems names entries by dimension', () => {
  expect(costItems([bucket({ model: 'opus' }, 3, 2), bucket({ model: '' }, 1)], 'model')).toEqual([
    { name: 'opus', costUsd: 3, runs: 2 },
    { name: 'unknown', costUsd: 1, runs: 1 },
  ])
})
