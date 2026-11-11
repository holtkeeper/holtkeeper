import { describe, expect, test } from 'bun:test'

import type { AiUsageBucket } from '@holtkeeper/api'

import {
  forecastAutomaticSpend,
  forecastFrom,
  forecastSegments,
  weekStart,
} from './automation-forecast.ts'

const bucket = (week: string, analyzer: string, costUsd: number): AiUsageBucket => ({
  key: { week, analyzer },
  costUsd,
  runs: 1,
  errors: 0,
  denied: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  avgDurationMs: 0,
})

const now = new Date('2026-11-11T12:00:00.000Z')
const budget = { weeklyUsd: 150, reserveUsd: 25, spentUsd: 20 }

describe('automatic AI spend forecast', () => {
  test('weeks start on Monday in UTC', () => {
    expect(weekStart(now)).toBe('2026-11-09')
    expect(weekStart(new Date('2026-11-09T00:00:00.000Z'))).toBe('2026-11-09')
    expect(weekStart(new Date('2026-11-08T23:59:00.000Z'))).toBe('2026-11-02')
    expect(forecastFrom(now)).toBe('2026-10-12T00:00:00.000Z')
  })

  test('averages the full weeks since usage started, analyzer runs only', () => {
    const forecast = forecastAutomaticSpend(
      [
        bucket('2026-10-26', 'review', 12),
        bucket('2026-10-26', '', 40),
        bucket('2026-11-02', 'review', 18),
        bucket('2026-11-02', 'guide', 3),
        bucket('2026-11-09', 'review', 4),
      ],
      { now, budget },
    )
    expect(forecast.weeks).toBe(2)
    expect(forecast.byAnalyzer).toEqual([
      { analyzer: 'review', weeklyUsd: 15 },
      { analyzer: 'guide', weeklyUsd: 1.5 },
    ])
    expect(forecast.forecastUsd).toBe(16.5)
    expect(forecast.thisWeekUsd).toBe(4)
    expect(forecast.tone).toBe('success')
    expect(forecastSegments(forecast)).toEqual([
      { value: 4, tone: 'accent', label: 'USD automatic so far' },
      { value: 12.5, tone: 'info', label: 'USD automatic forecast' },
      { value: 16, tone: 'default', label: 'USD other work' },
    ])
  })

  test('projects this week when no full week is recorded, never below what it spent', () => {
    const forecast = forecastAutomaticSpend([bucket('2026-11-09', 'review', 10)], {
      now,
      budget: { weeklyUsd: 30, reserveUsd: 10, spentUsd: 10 },
    })
    expect(forecast.weeks).toBe(0)
    expect(forecast.forecastUsd).toBeCloseTo(28)
    expect(forecast.tone).toBe('danger')
    expect(forecastSegments(forecast)[1]?.tone).toBe('danger')
  })

  test('warns near the automatic limit and stays neutral without a budget', () => {
    const buckets = [bucket('2026-11-02', 'review', 110)]
    expect(forecastAutomaticSpend(buckets, { now, budget }).tone).toBe('warning')
    const none = forecastAutomaticSpend([], { now })
    expect(none).toEqual({
      weeks: 0,
      forecastUsd: 0,
      thisWeekUsd: 0,
      byAnalyzer: [],
      tone: 'default',
    })
  })
})
