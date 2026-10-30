import { describe, expect, test } from 'bun:test'

import { createManualClock, settle } from './clock.ts'
import { createLimiter } from './limiter.ts'
import { type LimiterKv, storeLimiterState } from './store-state.ts'

function fakeKv(): LimiterKv & { writes: number; conflictOnce(): void } {
  const values = new Map<string, string>()
  let conflict = false
  const kv = {
    writes: 0,
    conflictOnce() {
      conflict = true
    },
    async get(key: string) {
      const value = values.get(key)
      return value === undefined ? undefined : JSON.parse(value)
    },
    async compareAndSet(key: string, expected: unknown, value: unknown) {
      if (conflict) {
        conflict = false
        return false
      }
      const current = values.get(key)
      if (
        (current ?? 'missing') !== (expected === undefined ? 'missing' : JSON.stringify(expected))
      )
        return false
      values.set(key, JSON.stringify(value))
      kv.writes++
      return true
    },
  }
  return kv
}

describe('storeLimiterState', () => {
  test('two limiters on one store share a concurrency limit', async () => {
    const kv = fakeKv()
    const clock = createManualClock()
    const a = createLimiter({ clock, state: storeLimiterState({ kv, clock, processId: 'a' }) })
    const b = createLimiter({
      clock,
      pollMs: 1000,
      state: storeLimiterState({ kv, clock, processId: 'b' }),
    })
    a.configure('cred', { maxConcurrent: 1 })
    b.configure('cred', { maxConcurrent: 1 })

    const lease = await a.acquire('cred')
    expect(await b.saturated('cred')).toBe(true)
    let granted = false
    const waiting = b.acquire('cred').then((l) => {
      granted = true
      return l
    })
    await clock.advance(1500)
    expect(granted).toBe(false)
    await lease.release()
    await clock.advance(1000)
    expect(granted).toBe(true)
    await (await waiting).release()
    expect(await a.saturated('cred')).toBe(false)
  })

  test('retries on write conflicts and lists keys', async () => {
    const kv = fakeKv()
    const state = storeLimiterState({ kv, processId: 'p' })
    kv.conflictOnce()
    let runs = 0
    await state.transact('x', (s) => {
      runs++
      s.dayTokens += 5
    })
    expect(runs).toBe(2)
    expect((await state.read('x'))?.dayTokens).toBe(5)
    expect(await state.keys()).toEqual(['x'])
    state.close()
  })

  test('slots of a process that stopped heartbeating are given back', async () => {
    const kv = fakeKv()
    const clock = createManualClock()
    const dead = storeLimiterState({ kv, clock, processId: 'dead', staleMs: 60_000 })
    const alive = storeLimiterState({ kv, clock, processId: 'alive', staleMs: 60_000 })
    await dead.transact('k', (s) => {
      s.inFlight += 2
      s.reservedTokens += 100
    })
    dead.close()
    await clock.advance(30_000)
    expect(await alive.transact('k', (s) => s.inFlight)).toBe(2)
    await clock.advance(31_000)
    expect(await alive.transact('k', (s) => [s.inFlight, s.reservedTokens])).toEqual([0, 0])
  })

  test('held slots are heartbeated so they do not go stale', async () => {
    const kv = fakeKv()
    const clock = createManualClock()
    const holder = storeLimiterState({
      kv,
      clock,
      processId: 'h',
      staleMs: 60_000,
      heartbeatMs: 20_000,
    })
    const other = storeLimiterState({ kv, clock, processId: 'o', staleMs: 60_000 })
    await holder.transact('k', (s) => {
      s.inFlight += 1
    })
    await clock.advance(200_000)
    await settle()
    expect(await other.transact('k', (s) => s.inFlight)).toBe(1)
    await holder.transact('k', (s) => {
      s.inFlight -= 1
    })
    expect(clock.pending).toBe(0)
    holder.close()
  })
})
