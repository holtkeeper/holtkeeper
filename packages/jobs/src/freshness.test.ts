import { describe, expect, test } from 'bun:test'

import { type FreshnessInput, decideFreshness, inNightWindow, matchesAnyPath } from './freshness.ts'

const at = (time: string) => new Date(`2026-11-11T${time}:00.000Z`)
const context = (time: string) => ({
  now: at(time),
  nightWindow: { from: '01:00', to: '07:00' },
  timezone: 'UTC',
})
const sha = (char: string) => char.repeat(40)
const on = { mode: 'on', factor: 3 } as const

const change = (extra: Partial<FreshnessInput> = {}): FreshnessInput => ({
  refresh: { on: 'change', minInterval: '6h' },
  ai: false,
  latest: { sha: sha('a'), createdAt: '2026-11-11T02:00:00.000Z' },
  head: { sha: sha('b'), at: '2026-11-11T09:00:00.000Z' },
  mode: on,
  ...extra,
})

describe('decideFreshness: change', () => {
  test('a record of an older commit runs once the head settled and minInterval passed', () => {
    expect(decideFreshness(change(), context('10:00'))).toEqual({
      action: 'run',
      reason: 'sha aaaaaaa != head bbbbbbb',
    })
  })

  test('the record of the head is fresh', () => {
    expect(
      decideFreshness(
        change({ head: { sha: sha('a'), at: '2026-11-11T09:00:00.000Z' } }),
        context('10:00'),
      ).action,
    ).toBe('fresh')
  })

  test('a head that moved in the last 30 minutes waits', () => {
    expect(decideFreshness(change(), context('09:20'))).toEqual({
      action: 'wait',
      reason: 'the head moved less than 30 minutes ago',
      nextAt: '2026-11-11T09:30:00.000Z',
    })
  })

  test('minInterval counts from the record', () => {
    const decision = decideFreshness(
      change({ latest: { sha: sha('a'), createdAt: '2026-11-11T08:00:00.000Z' } }),
      context('10:00'),
    )
    expect(decision).toMatchObject({ action: 'wait', nextAt: '2026-11-11T14:00:00.000Z' })
  })

  test('slower stretches minInterval by its factor', () => {
    const decision = decideFreshness(
      change({ mode: { mode: 'slower', factor: 3 } }),
      context('10:00'),
    )
    expect(decision).toMatchObject({
      action: 'wait',
      reason: 'minInterval 6h x3 has not passed since the record',
      nextAt: '2026-11-11T20:00:00.000Z',
    })
  })

  test('off skips, an active job waits, an unknown head waits', () => {
    expect(
      decideFreshness(change({ mode: { mode: 'off', factor: 3 } }), context('10:00')).action,
    ).toBe('skip')
    expect(decideFreshness(change({ active: true }), context('10:00')).action).toBe('wait')
    const { head: _head, ...unknown } = change()
    expect(decideFreshness(unknown, context('10:00')).action).toBe('wait')
  })

  test('records without a sha are stale, but analyzers that call an LLM skip them', () => {
    const latest = { createdAt: '2026-11-01T02:00:00.000Z' }
    expect(decideFreshness(change({ latest }), context('10:00'))).toEqual({
      action: 'run',
      reason: 'record has no sha, head bbbbbbb',
    })
    const ai = change({ latest, ai: true, refresh: { on: 'change', minInterval: '7d' } })
    expect(decideFreshness(ai, context('10:00')).action).toBe('skip')
    const { latest: _latest, ...none } = ai
    expect(decideFreshness(none, context('10:00')).action).toBe('skip')
  })

  test('no matching path changed counts as fresh', () => {
    expect(decideFreshness(change({ pathsChanged: false }), context('10:00')).action).toBe('fresh')
  })

  test('heavy analyzers wait for the night window', () => {
    const heavy = change({
      refresh: { on: 'change', minInterval: '1d', heavy: true },
      latest: { sha: sha('a'), createdAt: '2026-11-09T02:00:00.000Z' },
    })
    expect(decideFreshness(heavy, context('10:00'))).toEqual({
      action: 'wait',
      reason: 'heavy: runs only in the night window',
      nextAt: '2026-11-12T01:00:00.000Z',
    })
    expect(
      decideFreshness(
        { ...heavy, head: { sha: sha('b'), at: '2026-11-11T00:00:00.000Z' } },
        context('02:00'),
      ).action,
    ).toBe('run')
  })

  test('a failed freshness job holds the next try back by the interval', () => {
    const decision = decideFreshness(
      change({ lastJob: { id: 'j1', status: 'failed', createdAt: '2026-11-11T08:00:00.000Z' } }),
      context('10:00'),
    )
    expect(decision).toEqual({
      action: 'wait',
      reason: 'the last freshness job j1 ended failed',
      nextAt: '2026-11-11T14:00:00.000Z',
    })
  })
})

const time = (extra: Partial<FreshnessInput> = {}): FreshnessInput => ({
  refresh: { on: 'time', cadence: '7d' },
  ai: false,
  latest: { createdAt: '2026-11-03T10:00:00.000Z' },
  mode: on,
  ...extra,
})

describe('decideFreshness: time', () => {
  test('runs once the cadence elapsed, without a head', () => {
    expect(decideFreshness(time(), context('10:00'))).toEqual({
      action: 'run',
      reason: 'cadence 7d elapsed',
    })
  })

  test('is fresh before, with the time it comes due', () => {
    expect(
      decideFreshness(
        time({ latest: { createdAt: '2026-11-08T10:00:00.000Z' } }),
        context('10:00'),
      ),
    ).toEqual({
      action: 'fresh',
      reason: 'cadence 7d has not passed',
      nextAt: '2026-11-15T10:00:00.000Z',
    })
  })

  test('a missing record runs', () => {
    const { latest: _latest, ...none } = time()
    expect(decideFreshness(none, context('10:00'))).toEqual({
      action: 'run',
      reason: 'no record yet',
    })
  })
})

test('inNightWindow crosses midnight and honors the zone', () => {
  const window = { from: '22:00', to: '06:00' }
  expect(inNightWindow(at('23:30'), window, 'UTC')).toBe(true)
  expect(inNightWindow(at('05:59'), window, 'UTC')).toBe(true)
  expect(inNightWindow(at('12:00'), window, 'UTC')).toBe(false)
  expect(inNightWindow(at('12:00'), window, 'Pacific/Auckland')).toBe(true)
})

test('matchesAnyPath matches globs at any depth', () => {
  expect(matchesAnyPath(['src/a.ts', 'apps/web/bun.lock'], ['**/bun.lock'])).toBe(true)
  expect(matchesAnyPath(['README.md'], ['**/package.json'])).toBe(false)
})
