import { describe, expect, test } from 'bun:test'

import { createManualClock, settle } from './clock.ts'
import { type Lease, LimitExceededError, createLimiter } from './limiter.ts'
import type { LimitPolicy } from './policy.ts'
import { failure } from './test-helpers.ts'

const setup = (policy: LimitPolicy) => {
  const clock = createManualClock()
  const limiter = createLimiter({ clock })
  limiter.configure('k', policy)
  return { clock, limiter }
}

/** Tracks when each acquire settles. */
const track = (promise: Promise<Lease>, log: string[], name: string) => {
  const box: { lease?: Lease; error?: unknown } = {}
  void promise.then(
    (lease) => {
      box.lease = lease
      log.push(name)
      return undefined
    },
    (error: unknown) => {
      box.error = error
      log.push(`${name}!`)
    },
  )
  return box
}

describe('createLimiter', () => {
  test('grants in arrival order and never lets a later caller overtake', async () => {
    const { limiter } = setup({ maxConcurrent: 1 })
    const log: string[] = []
    const a = track(limiter.acquire('k'), log, 'a')
    const b = track(limiter.acquire('k'), log, 'b')
    const c = track(limiter.acquire('k'), log, 'c')
    await settle()
    expect(log).toEqual(['a'])
    await a.lease?.release()
    await settle()
    expect(log).toEqual(['a', 'b'])
    await b.lease?.release()
    await settle()
    expect(log).toEqual(['a', 'b', 'c'])
    await c.lease?.release()
  })

  test('a big request at the head blocks smaller ones behind it', async () => {
    const { clock, limiter } = setup({ tokensPerMinute: 600 })
    const log: string[] = []
    const first = track(limiter.acquire('k', { tokens: 500 }), log, 'first')
    const big = track(limiter.acquire('k', { tokens: 300 }), log, 'big')
    track(limiter.acquire('k', { tokens: 50 }), log, 'small')
    await settle()
    expect(log).toEqual(['first'])
    // 600 tokens/min = 10 per second; 100 left, 200 more needed.
    await clock.advance(19_999)
    expect(log).toEqual(['first'])
    await clock.advance(1)
    expect(log).toEqual(['first', 'big'])
    await clock.advance(5000)
    expect(log).toEqual(['first', 'big', 'small'])
    expect(first.lease?.tokens).toBe(500)
    expect(big.lease).toBeDefined()
  })

  test('holds at most maxConcurrent leases', async () => {
    const { limiter } = setup({ maxConcurrent: 2 })
    const log: string[] = []
    const leases = [1, 2, 3].map((n) => track(limiter.acquire('k'), log, `${n}`))
    await settle()
    expect(log).toEqual(['1', '2'])
    expect((await limiter.snapshot()).k).toMatchObject({ inFlight: 2, queued: 1 })
    expect(await limiter.saturated('k')).toBe(true)
    await leases[0]?.lease?.release()
    await leases[0]?.lease?.release()
    await settle()
    expect(log).toEqual(['1', '2', '3'])
    expect((await limiter.snapshot()).k).toMatchObject({ inFlight: 2, queued: 0 })
  })

  test('refills the request bucket continuously up to burst', async () => {
    const { clock, limiter } = setup({ requestsPerMinute: 60, burst: 2 })
    const log: string[] = []
    track(limiter.acquire('k'), log, 'a')
    track(limiter.acquire('k'), log, 'b')
    track(limiter.acquire('k'), log, 'c')
    await settle()
    expect(log).toEqual(['a', 'b'])
    expect((await limiter.snapshot()).k?.requestsLeft).toBe(0)
    await clock.advance(999)
    expect(log).toEqual(['a', 'b'])
    await clock.advance(1)
    expect(log).toEqual(['a', 'b', 'c'])
    await clock.advance(60_000)
    expect((await limiter.snapshot()).k?.requestsLeft).toBe(2)
  })

  test('a throttle cools down every caller of the key, with exponential backoff', async () => {
    const { clock, limiter } = setup({
      backoff: { onStatus: [429], baseMs: 1000, maxMs: 10_000 },
    })
    const log: string[] = []
    const first = await limiter.acquire('k')
    await first.throttle({ delayMs: 5000 })
    await first.release()
    const snapshot = (await limiter.snapshot()).k
    expect(snapshot?.coolDownUntil).toBe('2026-10-30T10:00:05.000Z')
    expect(snapshot?.last429At).toBe('2026-10-30T10:00:00.000Z')
    expect(await limiter.saturated('k')).toBe(true)

    const other = track(limiter.acquire('k'), log, 'other')
    const another = track(limiter.acquire('k'), log, 'another')
    await clock.advance(4999)
    expect(log).toEqual([])
    await clock.advance(1)
    expect(log).toEqual(['other', 'another'])
    await other.lease?.release()
    await another.lease?.release()

    // No hint: base delay, doubling while throttles repeat without a clean release.
    await limiter.throttle('k')
    expect((await limiter.snapshot()).k?.coolDownUntil).toBe('2026-10-30T10:00:06.000Z')
    await clock.advance(1000)
    await limiter.throttle('k')
    expect((await limiter.snapshot()).k?.coolDownUntil).toBe('2026-10-30T10:00:08.000Z')
    // A second throttle during the same cool-down does not double again.
    await limiter.throttle('k')
    expect((await limiter.snapshot()).k?.coolDownUntil).toBe('2026-10-30T10:00:08.000Z')
    await clock.advance(2000)
    const clean = await limiter.acquire('k')
    await clean.release()
    await limiter.throttle('k')
    expect((await limiter.snapshot()).k?.coolDownUntil).toBe('2026-10-30T10:00:09.000Z')
    // Hints are capped at maxMs.
    await clock.advance(1000)
    await limiter.throttle('k', { delayMs: 3_600_000 })
    expect((await limiter.snapshot()).k?.coolDownUntil).toBe('2026-10-30T10:00:19.000Z')
  })

  test('aborting while queued rejects with the reason and lets the next caller in', async () => {
    const { limiter } = setup({ maxConcurrent: 1 })
    const log: string[] = []
    const holder = track(limiter.acquire('k'), log, 'holder')
    const controller = new AbortController()
    const aborted = track(limiter.acquire('k', {}, controller.signal), log, 'aborted')
    track(limiter.acquire('k'), log, 'next')
    await settle()
    controller.abort(new Error('gone'))
    await settle()
    expect(log).toEqual(['holder', 'aborted!'])
    expect((aborted.error as Error).message).toBe('gone')
    expect((await limiter.snapshot()).k?.queued).toBe(1)
    await holder.lease?.release()
    await settle()
    expect(log).toEqual(['holder', 'aborted!', 'next'])

    const done = new AbortController()
    done.abort(new Error('already'))
    expect(await failure(limiter.acquire('k', {}, done.signal))).toHaveProperty(
      'message',
      'already',
    )
  })

  test('daily token and cost caps deny with LimitExceededError until UTC midnight', async () => {
    const { clock, limiter } = setup({ tokensPerDay: 1000, costPerDayUsd: 5 })
    const first = await limiter.acquire('k', { tokens: 600 })
    expect(await failure(limiter.acquire('k', { tokens: 500 }))).toBeInstanceOf(LimitExceededError)
    await first.release({ tokens: 700, costUsd: 1 })
    const error = await limiter.acquire('k', { tokens: 400 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LimitExceededError)
    expect(error).toMatchObject({ limit: 'tokensPerDay', resetsAt: '2026-10-31T00:00:00.000Z' })
    const small = await limiter.acquire('k', { tokens: 300 })
    await small.release({ tokens: 10, costUsd: 4 })
    expect((await limiter.snapshot()).k).toMatchObject({ dayTokens: 710, dayCostUsd: 5 })
    expect(await limiter.saturated('k')).toBe(true)
    expect(await failure(limiter.acquire('k', { tokens: 1 }))).toMatchObject({
      limit: 'costPerDayUsd',
    })

    await clock.advance(14 * 3_600_000)
    const tomorrow = await limiter.acquire('k', { tokens: 900 })
    await tomorrow.release()
    expect((await limiter.snapshot()).k).toMatchObject({ dayTokens: 900, dayCostUsd: 0 })
  })

  test('release corrects the token estimate in the per-minute bucket', async () => {
    const { limiter } = setup({ tokensPerMinute: 1000 })
    const lease = await limiter.acquire('k', { tokens: 800 })
    expect((await limiter.snapshot()).k?.tokensLeft).toBe(200)
    await lease.release({ tokens: 100 })
    expect((await limiter.snapshot()).k?.tokensLeft).toBe(900)
    const over = await limiter.acquire('k', { tokens: 100 })
    await over.release({ tokens: 1500 })
    expect((await limiter.snapshot()).k?.tokensLeft).toBe(0)
  })

  test('keys are independent and unconfigured keys are unlimited', async () => {
    const { limiter } = setup({ maxConcurrent: 1 })
    await limiter.acquire('k')
    const leases = await Promise.all([1, 2, 3].map(() => limiter.acquire('free')))
    expect(leases).toHaveLength(3)
    expect(await limiter.saturated('free')).toBe(false)
    expect(Object.keys(await limiter.snapshot())).toEqual(['free', 'k'])
  })
})
