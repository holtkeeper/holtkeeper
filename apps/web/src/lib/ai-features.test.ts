import { describe, expect, test } from 'bun:test'

import type { AiUsageBucket } from '@holtkeeper/api'

import {
  budgetMarks,
  capStatus,
  featureBreakdown,
  featureColor,
  featureItems,
  featureOf,
  toolUsers,
} from './ai-features.ts'

const bucket = (taskKind: string, costUsd: number, runs = 1, unknownCost = 0): AiUsageBucket =>
  ({
    key: { taskKind },
    costUsd,
    runs,
    unknownCost,
    denied: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }) as AiUsageBucket

describe('featureOf', () => {
  test('maps task kinds to features, unknown and empty ones to Other', () => {
    expect(featureOf('review')).toBe('reviews')
    expect(featureOf('triage')).toBe('reviews')
    expect(featureOf('write-task')).toBe('tasks')
    expect(featureOf('chat-summary')).toBe('chat')
    expect(featureOf('learning')).toBe('knowledge')
    expect(featureOf('release-notes')).toBe('releases')
    expect(featureOf('widget-digest')).toBe('other')
    expect(featureOf('')).toBe('other')
  })
})

describe('featureBreakdown', () => {
  test('sums task kinds per feature with shares, Other last', () => {
    const rows = featureBreakdown([
      { feature: 'other', costUsd: 9, runs: 3 },
      { feature: 'review', costUsd: 20, runs: 4 },
      { feature: 'chat', costUsd: 6, runs: 10 },
      { feature: 'triage', costUsd: 5, runs: 1 },
      { feature: 'widget-digest', costUsd: 10, runs: 2 },
    ])
    expect(rows.map((row) => [row.feature, row.label, row.costUsd, row.runs, row.kinds])).toEqual([
      ['reviews', 'Reviews', 25, 5, ['review', 'triage']],
      ['chat', 'Chat', 6, 10, ['chat']],
      ['other', 'Other', 19, 5, ['', 'widget-digest']],
    ])
    expect(rows.map((row) => row.share)).toEqual([0.5, 0.12, 0.38])
  })

  test('nothing spent gives no rows, zero cost gives zero shares', () => {
    expect(featureBreakdown([])).toEqual([])
    expect(featureBreakdown([{ feature: 'chat', costUsd: 0, runs: 2 }])[0]?.share).toBe(0)
  })
})

describe('featureItems', () => {
  test('sums usage buckets the same way and keeps unknown costs', () => {
    const items = featureItems([
      bucket('review', 2, 3),
      bucket('chat', 4, 10, 2),
      bucket('triage', 3, 1),
    ])
    expect(items.map((item) => [item.feature, item.costUsd, item.runs, item.unknownCost])).toEqual([
      ['reviews', 5, 4, 0],
      ['chat', 4, 10, 2],
    ])
  })
})

describe('meter', () => {
  test('colors darken by rank and Other stays lightest', () => {
    expect(featureColor('reviews', 0)).toContain('88%')
    expect(featureColor('chat', 9)).toContain('20%')
    expect(featureColor('other', 0)).toContain('12%')
  })

  test('places the warning and stop lines on the weekly limit', () => {
    expect(budgetMarks({ weeklyUsd: 150, warnPercent: 80, spentUsd: 84.2 })).toEqual({
      warnUsd: 120,
      warn: 80,
      stop: 100,
      scaleUsd: 150,
    })
    const over = budgetMarks({ weeklyUsd: 100, warnPercent: 50, spentUsd: 200 })
    expect(over).toEqual({ warnUsd: 50, warn: 25, stop: 50, scaleUsd: 200 })
    expect(budgetMarks({ weeklyUsd: 0, warnPercent: 80, spentUsd: 0 }).stop).toBe(0)
  })
})

describe('caps and tools', () => {
  test('a cap reads as within, close to or at its limit', () => {
    expect(capStatus({ percent: 40, warnPercent: 80 })).toEqual({
      tone: 'success',
      label: 'Within budget',
    })
    expect(capStatus({ percent: 80, warnPercent: 80 }).label).toBe('Close to the limit')
    expect(capStatus({ percent: 120, warnPercent: 80 }).tone).toBe('danger')
  })

  test('names who gets a tool', () => {
    expect(toolUsers(['review', 'write-task', 'mcp', 'lint'])).toBe(
      'Reviews, Agent tasks, MCP clients, lint',
    )
  })
})
