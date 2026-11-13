import { describe, expect, test } from 'bun:test'

import { memoryStore } from '@holtkeeper/store/memory'

import { dailyLimitsOf, enqueueUnique } from './enqueue.ts'

const at = '2026-11-13T10:00:00.000Z'
const request = (path: string, analyzer = 'starter') => ({
  analyzer,
  repo: { forge: 'work', path },
  trigger: 'new-repo' as const,
})

describe('enqueueUnique', () => {
  test('a daily limit moves the jobs beyond it to the next days with room', async () => {
    const store = memoryStore()
    await store.jobs.enqueue({ ...request('acme/earlier'), createdAt: at })
    const { enqueued } = await enqueueUnique(
      store.jobs,
      ['a', 'b', 'c', 'd', 'e'].map((name) => request(`acme/${name}`)),
      at,
      { dailyLimits: { starter: 2 } },
    )
    expect(enqueued.map((job) => [job.repo.path, job.runAfter])).toEqual([
      ['acme/a', at],
      ['acme/b', '2026-11-14T00:00:00.000Z'],
      ['acme/c', '2026-11-14T00:00:00.000Z'],
      ['acme/d', '2026-11-15T00:00:00.000Z'],
      ['acme/e', '2026-11-15T00:00:00.000Z'],
    ])

    const later = await enqueueUnique(store.jobs, [request('acme/f')], at, {
      dailyLimits: { starter: 2 },
    })
    expect(later.enqueued[0]?.runAfter).toBe('2026-11-16T00:00:00.000Z')
  })

  test('canceled jobs, other kinds and duplicates take no slot', async () => {
    const store = memoryStore()
    const canceled = await store.jobs.enqueue({ ...request('acme/gone'), createdAt: at })
    await store.jobs.cancel(canceled.id, at)
    const { enqueued, skipped } = await enqueueUnique(
      store.jobs,
      [request('acme/a'), request('acme/a'), request('acme/b', 'quality'), request('acme/c')],
      at,
      { dailyLimits: { starter: 1 } },
    )
    expect(skipped).toHaveLength(1)
    expect(enqueued.map((job) => [job.repo.path, job.analyzer, job.runAfter])).toEqual([
      ['acme/a', 'starter', at],
      ['acme/b', 'quality', at],
      ['acme/c', 'starter', '2026-11-14T00:00:00.000Z'],
    ])
  })

  test('dailyLimitsOf keeps positive limits only', () => {
    expect(
      dailyLimitsOf([
        { kind: 'starter', dailyLimit: 10 },
        { kind: 'off', dailyLimit: 0 },
        { kind: 'quality' },
      ]),
    ).toEqual({ starter: 10 })
  })
})
