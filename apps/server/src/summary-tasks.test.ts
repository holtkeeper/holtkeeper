import { describe, expect, test } from 'bun:test'

import type { KvStore } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'

import { summaryTasks } from './summary-tasks.ts'

const summary = (markdown: string) => ({ markdown, code: false, cached: false })

const gate = () => {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { hold: promise, open: () => resolve() }
}

const setup = (kv: Partial<KvStore> & Pick<KvStore, 'get' | 'set'> = memoryStore().kv!) => {
  let clock = new Date('2026-11-01T09:00:00.000Z')
  const background: Promise<unknown>[] = []
  const tasks = summaryTasks({
    kv,
    now: () => clock,
    onBackground: (work) => void background.push(work),
    pollMs: 1,
  })
  return {
    tasks,
    kv,
    background,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms)
    },
    settled: () => Promise.all(background),
  }
}

describe('summaryTasks', () => {
  test('starts a run, joins it while it runs and answers the result', async () => {
    const { tasks, settled } = setup()
    const { hold, open } = gate()
    let runs = 0
    const run = async () => {
      runs++
      await hold
      return { summary: summary('Widgets turn.'), keepSeconds: 60 }
    }
    expect(await tasks.read('k')).toEqual({ status: 'none' })
    expect(await tasks.start('k', run)).toEqual({
      status: 'running',
      startedAt: '2026-11-01T09:00:00.000Z',
    })
    expect(await tasks.start('k', run)).toMatchObject({ status: 'running' })
    open()
    await settled()
    expect(await tasks.read('k')).toEqual({ status: 'done', ...summary('Widgets turn.') })
    expect(await tasks.start('k', run)).toMatchObject({ status: 'done' })
    expect(runs).toBe(1)
  })

  test('two concurrent starts run once even without compareAndSet', async () => {
    const values = new Map<string, unknown>()
    const { tasks, settled } = setup({
      get: async (key) => values.get(key),
      set: async (key, value) => void values.set(key, value),
    })
    let runs = 0
    const run = async () => {
      runs++
      return { summary: summary('Once.'), keepSeconds: 60 }
    }
    await Promise.all([tasks.start('k', run), tasks.start('k', run)])
    await settled()
    expect(runs).toBe(1)
  })

  test('a lost compareAndSet race answers the winner instead of running', async () => {
    const store = memoryStore().kv!
    const winner = { status: 'running', startedAt: '2026-11-01T08:59:00.000Z', runId: 'other' }
    const { tasks } = setup({
      get: (key) => store.get(key),
      set: (key, value, ttl) => store.set(key, value, ttl),
      compareAndSet: async (key) => {
        await store.set(key, winner)
        return false
      },
    })
    let runs = 0
    const state = await tasks.start('k', async () => {
      runs++
      return { summary: summary('Never.'), keepSeconds: 60 }
    })
    expect(state).toEqual({ status: 'running', startedAt: '2026-11-01T08:59:00.000Z' })
    expect(runs).toBe(0)
  })

  test('a marker not renewed for a while reads as none and the next start runs again', async () => {
    const { tasks, advance } = setup()
    let runs = 0
    const stuck = async () => {
      runs++
      return new Promise<never>(() => {})
    }
    await tasks.start('k', stuck)
    advance(14 * 60_000)
    expect(await tasks.read('k')).toMatchObject({ status: 'running' })
    advance(2 * 60_000)
    expect(await tasks.read('k')).toEqual({ status: 'none' })
    expect(await tasks.start('k', stuck)).toMatchObject({
      status: 'running',
      startedAt: '2026-11-01T09:16:00.000Z',
    })
    expect(runs).toBe(2)
  })

  test('keeps a failure, then starts again', async () => {
    const { tasks, settled } = setup()
    await tasks.start('k', async () => {
      throw new Error('model overloaded')
    })
    await settled()
    expect(await tasks.read('k')).toEqual({ status: 'failed', error: 'model overloaded' })
    expect(
      await tasks.start('k', async () => ({ summary: summary('Fine.'), keepSeconds: 60 })),
    ).toMatchObject({ status: 'running' })
  })

  test('a result that cannot be stored drops the marker instead of recording a failure', async () => {
    const values = new Map<string, unknown>()
    const deleted: string[] = []
    const { tasks, settled } = setup({
      get: async (key) => values.get(key),
      set: async (key, value) => {
        if ((value as { status?: string }).status === 'done') throw new Error('disk full')
        values.set(key, value)
      },
      delete: async (key) => {
        deleted.push(key)
        values.delete(key)
      },
    })
    await tasks.start('k', async () => ({ summary: summary('Lost.'), keepSeconds: 60 }))
    await settled()
    expect(deleted).toEqual(['k'])
    expect(await tasks.read('k')).toEqual({ status: 'none' })
  })

  test('settle waits for the run and answers its outcome', async () => {
    const { tasks } = setup()
    expect(
      await tasks.settle('k', async () => ({ summary: summary('Waited.'), keepSeconds: 60 })),
    ).toEqual({ status: 'done', ...summary('Waited.') })
  })
})
