import { describe, expect, test } from 'bun:test'

import type { AiUsageBucket } from '@holtkeeper/api'

import {
  automaticLimit,
  budgetBar,
  budgetDraft,
  budgetState,
  budgetTone,
  chartStart,
  comparisonLabel,
  costItems,
  formatDelta,
  formatRatio,
  formatTokens,
  formatUsd,
  niceScale,
  originDays,
  parseBudgetDraft,
  periodDelta,
  runStarter,
  tokensNote,
  topWithRest,
  totalTokens,
  untilLabel,
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
  unknownCost: 0,
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

  test('describes the delta against the period before', () => {
    expect(formatDelta(periodDelta(150, 100))).toBe('+50% vs last week')
    expect(formatDelta(periodDelta(50, 100), comparisonLabel.month)).toBe('-50% vs last month')
    expect(formatDelta(periodDelta(5, 0))).toBe('none last week')
    expect(formatDelta(periodDelta(0, 0), comparisonLabel['30d'])).toBe(
      'same as the 30 days before',
    )
  })
})

describe('weekly budgets', () => {
  const budget = { weeklyUsd: 150, reserveUsd: 25, warnPercent: 90, spentUsd: 0, forecastUsd: 0 }

  test('rates spend against the reserve and the weekly limit', () => {
    expect(budgetTone({ ...budget, spentUsd: 60, forecastUsd: 100 })).toBe('success')
    expect(budgetTone({ ...budget, spentUsd: 125, forecastUsd: 125 })).toBe('warning')
    expect(budgetTone({ ...budget, spentUsd: 150, forecastUsd: 150 })).toBe('danger')
  })

  test('warns once spend reaches the warn share', () => {
    const open = { ...budget, reserveUsd: 0, warnPercent: 80 }
    expect(budgetTone({ ...open, spentUsd: 119, forecastUsd: 119 })).toBe('success')
    expect(budgetTone({ ...open, spentUsd: 120, forecastUsd: 120 })).toBe('warning')
    expect(budgetState({ ...open, spentUsd: 120, forecastUsd: 120 }).label).toBe(
      'Close to the limit',
    )
  })

  test('warns when the forecast says automatic work stops this week', () => {
    expect(budgetTone({ ...budget, spentUsd: 40, forecastUsd: 126 })).toBe('warning')
    expect(budgetTone({ ...budget, spentUsd: 40, forecastUsd: 125 })).toBe('success')
  })

  test('places spend, forecast and the reserve marker on the bar', () => {
    expect(automaticLimit(budget)).toBe(125)
    expect(automaticLimit({ weeklyUsd: 10, reserveUsd: 25 })).toBe(0)
    expect(budgetBar({ ...budget, spentUsd: 75, forecastUsd: 300 })).toEqual({
      spent: 50,
      forecast: 100,
      reserve: (125 / 150) * 100,
    })
  })
})

describe('breakdowns', () => {
  test('costItems names entries by dimension, most expensive first', () => {
    expect(
      costItems([bucket({ model: '' }, 1), bucket({ model: 'model-a' }, 3, 2)], 'model'),
    ).toEqual([
      { name: 'model-a', costUsd: 3, runs: 2, unknownCost: 0 },
      { name: 'unknown', costUsd: 1, runs: 1, unknownCost: 0 },
    ])
  })

  test('folds the tail into one row', () => {
    const items = [5, 4, 3, 2].map((cost, index) => ({
      name: `acme/widget-${index}`,
      costUsd: cost,
      runs: 1,
      unknownCost: index === 3 ? 1 : 0,
    }))
    expect(topWithRest(items, 4)).toEqual({ top: items })
    const folded = topWithRest(items, 2)
    expect(folded.top.map((item) => item.name)).toEqual(['acme/widget-0', 'acme/widget-1'])
    expect(folded.rest).toEqual({ name: '2 more', count: 2, costUsd: 5, runs: 2, unknownCost: 1 })
  })
})

describe('daily chart', () => {
  const now = new Date('2026-11-11T15:00:00Z')

  test('starts on the Monday three weeks before this one', () => {
    expect(chartStart(now)).toBe('2026-10-19T00:00:00.000Z')
    expect(chartStart(new Date('2026-11-09T00:30:00Z'))).toBe('2026-10-19T00:00:00.000Z')
    expect(chartStart(new Date('2026-11-15T23:00:00Z'))).toBe('2026-10-19T00:00:00.000Z')
  })

  test('splits each day into people and automatic spend', () => {
    const days = originDays(
      [
        bucket({ day: '2026-10-19', origin: 'interactive' }, 2),
        bucket({ day: '2026-10-19', origin: 'automatic' }, 3),
        bucket({ day: '2026-11-11', origin: 'automatic' }, 1),
        bucket({ day: '2026-09-01', origin: 'automatic' }, 9),
      ],
      chartStart(now),
      now,
    )
    expect(days).toHaveLength(28)
    expect(days[0]).toEqual({
      day: '2026-10-19',
      people: 2,
      automatic: 3,
      future: false,
      today: false,
    })
    expect(days[23]).toMatchObject({ day: '2026-11-11', automatic: 1, today: true })
    expect(days[24]).toMatchObject({ day: '2026-11-12', future: true })
    expect(days.at(-1)?.day).toBe('2026-11-15')
  })

  test('picks a round axis top', () => {
    expect(niceScale(31.4)).toEqual({ max: 40, step: 10 })
    expect(niceScale(7)).toEqual({ max: 8, step: 2 })
    expect(niceScale(0)).toEqual({ max: 1, step: 0.25 })
  })
})

describe('budget card', () => {
  const budget = { weeklyUsd: 150, reserveUsd: 25, warnPercent: 90, spentUsd: 0, forecastUsd: 0 }

  test('names where the budget stands', () => {
    expect(budgetState({ ...budget, spentUsd: 40, forecastUsd: 100 })).toEqual({
      tone: 'success',
      label: 'On track',
    })
    expect(budgetState({ ...budget, spentUsd: 40, forecastUsd: 130 }).label).toBe(
      'Close to the limit',
    )
    expect(budgetState({ ...budget, spentUsd: 126, forecastUsd: 130 }).label).toBe(
      'Automatic work stopped',
    )
    expect(budgetState({ ...budget, spentUsd: 150, forecastUsd: 150 })).toEqual({
      tone: 'danger',
      label: 'Limit reached',
    })
  })

  test('counts down to the reset', () => {
    const now = new Date('2026-11-11T10:30:00Z')
    expect(untilLabel('2026-11-16T00:00:00Z', now)).toBe('4d 13h')
    expect(untilLabel('2026-11-11T15:50:00Z', now)).toBe('5h 20m')
    expect(untilLabel('2026-11-11T10:42:00Z', now)).toBe('12m')
    expect(untilLabel('2026-11-11T10:00:00Z', now)).toBe('now')
  })

  test('round-trips the budget form', () => {
    const draft = budgetDraft({ weeklyUsd: 150, reserveUsd: 25, warnPercent: 80, action: 'block' })
    expect(draft).toEqual({
      weeklyUsd: '150.00',
      reserveUsd: '25.00',
      warnPercent: '80',
      action: 'block',
    })
    expect(
      parseBudgetDraft({ ...draft, weeklyUsd: '$1,200', warnPercent: '75%', action: 'warn' }),
    ).toEqual({
      value: { weeklyUsd: 1200, reserveUsd: 25, warnPercent: 75, action: 'warn' },
    })
  })

  test('rejects budgets that cannot be saved', () => {
    const draft = {
      weeklyUsd: '150',
      reserveUsd: '25',
      warnPercent: '80',
      action: 'block' as const,
    }
    expect(parseBudgetDraft({ ...draft, weeklyUsd: '0' })).toHaveProperty('error')
    expect(parseBudgetDraft({ ...draft, weeklyUsd: '' })).toHaveProperty('error')
    expect(parseBudgetDraft({ ...draft, reserveUsd: '-1' })).toHaveProperty('error')
    expect(parseBudgetDraft({ ...draft, reserveUsd: '200' })).toHaveProperty('error')
    expect(parseBudgetDraft({ ...draft, reserveUsd: 'abc' })).toHaveProperty('error')
    expect(parseBudgetDraft({ ...draft, warnPercent: '0' })).toHaveProperty('error')
    expect(parseBudgetDraft({ ...draft, warnPercent: '101' })).toHaveProperty('error')
    expect(parseBudgetDraft({ ...draft, warnPercent: '82.5' })).toHaveProperty('error')
  })
})

describe('runs', () => {
  const run = {
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 3000,
    cacheWriteTokens: 0,
    turns: 1,
    outcome: 'ok' as const,
  }

  test('describes tokens by run shape', () => {
    expect(tokensNote(run)).toBe('4K in · 200 out')
    expect(tokensNote({ ...run, turns: 12 })).toBe('12 turns · 75% cached')
    expect(
      tokensNote({
        ...run,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        outcome: 'denied-budget',
      }),
    ).toBe('not sent')
  })

  test('points to what started the run', () => {
    const base = { actor: 'user-1', interactive: true }
    expect(runStarter({ ...base, jobId: 'j1', analysisId: 'a1' })).toEqual({
      kind: 'job',
      id: 'j1',
    })
    expect(runStarter({ ...base, analysisId: 'a1' })).toEqual({ kind: 'analysis', id: 'a1' })
    expect(runStarter(base)).toEqual({ kind: 'person', actor: 'user-1', name: 'user-1' })
    const id = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
    expect(runStarter({ actor: id, interactive: true })).toMatchObject({ name: '0a1b2c3d' })
    expect(
      runStarter(
        { actor: id, interactive: true },
        { [id]: { name: 'Jane Widget', avatarUrl: '' } },
      ),
    ).toEqual({ kind: 'person', actor: id, name: 'Jane Widget' })
    expect(runStarter({ actor: 'system', interactive: false })).toEqual({
      kind: 'system',
      actor: 'system',
    })
  })
})
