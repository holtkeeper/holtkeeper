import { describe, expect, test } from 'bun:test'

import type { Job } from '@holtkeeper/store'

import { claimRulesOf, describeWaitReason, waitReasons } from './wait.ts'

const now = '2026-03-04T10:00:00.000Z'

let seq = 0
const job = (overrides: Partial<Job> = {}): Job => ({
  id: `j${++seq}`,
  analyzer: 'widgets',
  repo: { forge: 'work', path: 'shapes/circle' },
  options: {},
  trigger: 'manual',
  status: 'queued',
  attempts: 0,
  maxAttempts: 3,
  runAfter: '2026-03-04T09:00:00.000Z',
  createdAt: '2026-03-04T09:00:00.000Z',
  attemptsHistory: [],
  ...overrides,
})

const rules = claimRulesOf([
  { kind: 'widgets', after: ['graph'] },
  { kind: 'graph' },
  { kind: 'fixer', exclusive: true },
])

describe('claimRulesOf', () => {
  test('collects exclusive kinds and after lists', () => {
    expect(rules).toEqual({ exclusive: ['fixer'], after: { widgets: ['graph'] } })
    expect(claimRulesOf([], 5000)).toEqual({ exclusive: [], after: {}, delayMs: 5000 })
  })

  test('keeps workers to the pools they serve', () => {
    const kinds = [{ kind: 'widgets' }, { kind: 'shaper', pool: 'write' }]
    expect(claimRulesOf(kinds)).toMatchObject({ except: ['shaper'] })
    expect(claimRulesOf(kinds, undefined, ['write'])).toMatchObject({ only: ['shaper'] })
    const both = claimRulesOf(kinds, undefined, ['default', 'write'])
    expect(both.only).toBeUndefined()
    expect(both.except).toBeUndefined()
  })
})

describe('waitReasons', () => {
  test('a job that is not queued has no reasons', () => {
    expect(waitReasons(job({ status: 'running' }), [], rules, now)).toEqual({
      reasons: [],
      ahead: 0,
    })
  })

  test('names a retry, the same analyzer running and the kinds it reads', () => {
    const target = job({
      attempts: 1,
      runAfter: '2026-03-04T10:05:00.000Z',
      createdAt: '2026-03-04T09:30:00.000Z',
    })
    const queue = [
      job({ status: 'running' }),
      job({
        analyzer: 'graph',
        createdAt: '2026-03-04T08:00:00.000Z',
        runAfter: '2026-03-04T08:00:00.000Z',
      }),
      job({ repo: { forge: 'work', path: 'shapes/square' } }),
    ]
    const wait = waitReasons(target, queue, rules, now)
    expect(wait.reasons).toEqual([
      { kind: 'retry', at: '2026-03-04T10:05:00.000Z', attempt: 1 },
      { kind: 'same-analyzer', analyzer: 'widgets' },
      { kind: 'after', analyzer: 'graph', state: 'queued' },
    ])
    expect(wait.ahead).toBe(2)
    expect(wait.reasons.map(describeWaitReason)).toEqual([
      'retries at 2026-03-04T10:05:00.000Z after attempt 1 failed',
      'a widgets job already runs on this repository',
      'waits for graph on this repository (queued ahead), whose results it reads',
    ])
  })

  test('exclusive jobs wait for running ones and hold back others', () => {
    const fixer = job({
      analyzer: 'fixer',
      createdAt: '2026-03-04T09:10:00.000Z',
      runAfter: '2026-03-04T09:10:00.000Z',
    })
    const reader = job({ status: 'running', analyzer: 'graph' })
    expect(waitReasons(fixer, [reader], rules, now).reasons).toEqual([
      { kind: 'exclusive-self', running: 1 },
    ])
    const later = job({
      createdAt: '2026-03-04T09:20:00.000Z',
      runAfter: '2026-03-04T09:20:00.000Z',
    })
    expect(waitReasons(later, [fixer], rules, now).reasons).toEqual([
      { kind: 'exclusive', analyzer: 'fixer', state: 'queued' },
    ])
  })

  test('a due job with nothing in its way only waits for a worker', () => {
    expect(waitReasons(job(), [], rules, now)).toEqual({ reasons: [], ahead: 0 })
  })
})
