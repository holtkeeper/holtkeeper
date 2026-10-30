import { describe, expect, test } from 'bun:test'

import { createManualClock } from '@holtkeeper/limits'
import { memoryStore } from '@holtkeeper/store/memory'

import { type LeaderDuty, startLeaderElection } from '../src/leader.ts'

const duty =
  (name: string, log: string[]): LeaderDuty =>
  () => {
    log.push(`${name} start`)
    return () => {
      log.push(`${name} stop`)
    }
  }

describe('startLeaderElection', () => {
  test('one contender leads; the other takes over after the leader stops renewing', async () => {
    const kv = memoryStore().kv!
    const clock = createManualClock()
    const log: string[] = []
    const a = startLeaderElection({
      kv,
      clock,
      holder: 'a',
      ttlMs: 30_000,
      duties: [duty('a', log)],
    })
    await clock.advance(0)
    const b = startLeaderElection({
      kv,
      clock,
      holder: 'b',
      ttlMs: 30_000,
      duties: [duty('b', log)],
    })
    await clock.advance(0)
    expect([a.leading, b.leading]).toEqual([true, false])
    await clock.advance(60_000)
    expect([a.leading, b.leading]).toEqual([true, false])
    expect(log).toEqual(['a start'])

    // `a` freezes (e.g. a paused pod): its renewals stop, but the lease is not released.
    const frozen = {
      acquireLease: kv.acquireLease!.bind(kv),
      releaseLease: kv.releaseLease!.bind(kv),
    }
    kv.acquireLease = async (key, holder, ttl, now) => {
      if (holder === 'a') throw new Error('network partition')
      return frozen.acquireLease(key, holder, ttl, now)
    }
    await clock.advance(10_000)
    expect(a.leading).toBe(false)
    expect(b.leading).toBe(false)
    await clock.advance(30_000)
    expect(b.leading).toBe(true)
    expect(log).toEqual(['a start', 'a stop', 'b start'])

    kv.acquireLease = frozen.acquireLease
    await clock.advance(30_000)
    expect([a.leading, b.leading]).toEqual([false, true])
    await a.stop()
    await b.stop()
    expect(log.at(-1)).toBe('b stop')
  })

  test('stop releases the lease so a contender takes it on its next round', async () => {
    const kv = memoryStore().kv!
    const clock = createManualClock()
    const log: string[] = []
    const a = startLeaderElection({
      kv,
      clock,
      holder: 'a',
      ttlMs: 30_000,
      duties: [duty('a', log)],
    })
    await clock.advance(0)
    const b = startLeaderElection({
      kv,
      clock,
      holder: 'b',
      ttlMs: 30_000,
      duties: [duty('b', log)],
    })
    await clock.advance(0)
    await a.stop()
    expect(await b.check()).toBe(true)
    expect(log).toEqual(['a start', 'a stop', 'b start'])
    await b.stop()
  })

  test('refuses a kv without leases', () => {
    expect(() => startLeaderElection({ kv: {}, duties: [] })).toThrow(/acquireLease/)
  })
})
