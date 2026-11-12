import { describe, expect, test } from 'bun:test'

import type { KvStore } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'

import { WORKERS_KEY, liveWorkers, removeWorker, touchWorker } from './registry.ts'
import { createWorker } from './worker.ts'

const at = (time: string) => new Date(`2026-10-30T${time}.000Z`)

/** A KV whose reads all land before any write, so concurrent writers really collide. */
function contended(kv: KvStore) {
  let lost = 0
  let gate = Promise.withResolvers<void>()
  let waiting = 0
  return {
    get lost() {
      return lost
    },
    kv: {
      get: async (key: string) => {
        const value = await kv.get(key)
        waiting++
        if (waiting >= 2) gate.resolve()
        await gate.promise
        return value
      },
      set: (key: string, value: unknown, ttl?: number) => kv.set(key, value, ttl),
      compareAndSet: async (key: string, expected: unknown, value: unknown) => {
        const written = await kv.compareAndSet!(key, expected, value)
        if (!written) {
          lost++
          gate = Promise.withResolvers<void>()
          gate.resolve()
        }
        return written
      },
    },
  }
}

describe('worker registry', () => {
  test('two workers writing at once through compareAndSet both stay listed', async () => {
    const { kv } = memoryStore()
    const shared = contended(kv!)
    const now = at('10:00:00')
    const results = await Promise.all([
      touchWorker(shared.kv, 'worker-a', now),
      touchWorker(shared.kv, 'worker-b', now),
    ])
    expect(results).toEqual([true, true])
    expect(shared.lost).toBe(1)
    expect((await liveWorkers(kv!, now)).map((worker) => worker.id).toSorted()).toEqual([
      'worker-a',
      'worker-b',
    ])
  })

  test('readers drop stale entries and the next write prunes them', async () => {
    const { kv } = memoryStore()
    await touchWorker(kv!, 'worker-old', at('10:00:00'))
    await touchWorker(kv!, 'worker-new', at('10:01:30'))
    expect(await liveWorkers(kv!, at('10:02:00'), 60_000)).toEqual([
      { id: 'worker-new', lastSeen: at('10:01:30').toISOString() },
    ])
    await touchWorker(kv!, 'worker-new', at('10:02:00'), 60_000)
    expect(Object.keys((await kv!.get(WORKERS_KEY)) as object)).toEqual(['worker-new'])
  })

  test('ignores a malformed value and removes a worker', async () => {
    const { kv } = memoryStore()
    await kv!.set(WORKERS_KEY, ['not', 'a', 'map'])
    expect(await liveWorkers(kv!, at('10:00:00'))).toEqual([])
    await touchWorker(kv!, 'worker-a', at('10:00:00'))
    await removeWorker(kv!, 'worker-a')
    expect(await liveWorkers(kv!, at('10:00:00'))).toEqual([])
  })

  test('a started worker lists itself and leaves on stop', async () => {
    const store = memoryStore()
    const now = at('10:00:00')
    const worker = createWorker({
      store,
      analyzers: [],
      contextFor: async () => {
        throw new Error('no jobs expected')
      },
      registry: store.kv!,
      workerId: 'worker-x',
      now: () => now,
      pollMs: 60_000,
    })
    await worker.start()
    expect(await liveWorkers(store.kv!, now)).toEqual([
      { id: 'worker-x', lastSeen: now.toISOString() },
    ])
    await worker.stop()
    expect(await liveWorkers(store.kv!, now)).toEqual([])
  })
})
