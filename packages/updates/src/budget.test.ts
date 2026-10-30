import { describe, expect, test } from 'bun:test'

import { createSpendWindow, firstDueAt, stretchFactors } from './budget.ts'
import { pollingConfig } from './setting.ts'

describe('stretchFactors', () => {
  test('slows every repository of an over-budget key by the same factor', () => {
    const demands = Array.from({ length: 100 }, () => ({
      key: 'token-a',
      intervalMs: 60_000,
      cost: 3,
    }))
    demands.push({ key: 'token-b', intervalMs: 300_000, cost: 3 })
    const factors = stretchFactors(demands, () => ({
      requestsPerMinute: 60,
    }))
    expect(factors.get('token-a')).toBe(5)
    expect(factors.get('token-b')).toBe(1)
  })

  test('leaves keys without a request rate alone', () => {
    const factors = stretchFactors([{ key: 'k', intervalMs: 30_000, cost: 100 }], () => ({
      requestsPerMinute: undefined,
    }))
    expect(factors.get('k')).toBe(1)
  })
})

describe('firstDueAt', () => {
  test('spreads repositories over one interval, the same way every time', () => {
    const now = 1_000_000
    const times = ['a/1', 'a/2', 'a/3', 'a/4'].map((repo) => firstDueAt(repo, now, 300_000))
    for (const at of times) {
      expect(at).toBeGreaterThanOrEqual(now)
      expect(at).toBeLessThan(now + 300_000)
    }
    expect(new Set(times).size).toBeGreaterThan(1)
    expect(firstDueAt('a/1', now, 300_000)).toBe(times[0] ?? 0)
  })
})

describe('createSpendWindow', () => {
  test('forgets spending older than the window', () => {
    const spend = createSpendWindow(60_000)
    spend.record('k', 0, 5)
    spend.record('k', 30_000, 2)
    expect(spend.used('k', 50_000)).toBe(7)
    expect(spend.used('k', 70_000)).toBe(2)
  })
})

describe('pollingConfig', () => {
  test('applies defaults and turns invalid values off', () => {
    expect(pollingConfig({ enabled: true })).toEqual({
      enabled: true,
      intervalMs: 300_000,
      events: ['mergeRequests', 'notes', 'pipelines', 'tags'],
      withWebhookMs: 3_600_000,
    })
    expect(pollingConfig({ enabled: true, interval: '10s' }).enabled).toBe(false)
    expect(pollingConfig({ enabled: true, withWebhook: 'off' }).withWebhookMs).toBeUndefined()
  })
})
