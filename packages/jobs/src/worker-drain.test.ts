import { describe, expect, test } from 'bun:test'

import type { AnyAnalyzer } from '@holtkeeper/analyzer'
import { createFakeRunner } from '@holtkeeper/exec/testing'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { z } from 'zod'

import type { ContextFor } from './context.ts'
import { createWorker } from './worker.ts'

const { runner } = createFakeRunner()
const contextFor: ContextFor = async (job) => ({
  context: { repo: job.repo, runner },
  cleanup: async () => {},
})

const analyzer = (run: AnyAnalyzer['run']): AnyAnalyzer => ({
  kind: 'size',
  analysis: { kind: 'size-data' } as AnyAnalyzer['analysis'],
  scope: 'repo',
  needs: {},
  options: z.object({}),
  run,
})

const enqueue = (store: Store, path: string) =>
  store.jobs.enqueue({
    analyzer: 'size',
    repo: { forge: 'work', path },
    trigger: 'manual',
    createdAt: new Date(Date.now() - 1000).toISOString(),
  })

describe('worker maxJobs and drain', () => {
  test('stops claiming after maxJobs and resolves exhausted', async () => {
    const store = memoryStore()
    for (const path of ['a', 'b', 'c']) await enqueue(store, path)
    const worker = createWorker({
      store,
      analyzers: [analyzer(async () => ({ data: {} }))],
      contextFor,
      concurrency: 2,
      maxJobs: 2,
      pollMs: 10,
    })
    await worker.start()
    await worker.exhausted
    await worker.stop()
    const jobs = await store.jobs.list()
    expect(jobs.filter((job) => job.status === 'succeeded')).toHaveLength(2)
    expect(jobs.filter((job) => job.status === 'queued')).toHaveLength(1)
  })

  test('drain lets quick jobs finish and requeues the ones past the timeout', async () => {
    const store = memoryStore()
    await enqueue(store, 'quick')
    await enqueue(store, 'slow')
    const worker = createWorker({
      store,
      analyzers: [
        analyzer(async ({ repo, signal }) => {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, repo.path === 'quick' ? 20 : 10_000)
            signal?.addEventListener('abort', () => clearTimeout(timer))
          })
          return { data: {} }
        }),
      ],
      contextFor,
      concurrency: 2,
    })
    await worker.start()
    expect(worker.running).toBe(2)
    const result = await worker.drain(200)
    expect(result).toEqual({ finished: 1, requeued: 1 })
    expect(worker.running).toBe(0)
    const byPath = Object.fromEntries((await store.jobs.list()).map((j) => [j.repo.path, j.status]))
    expect(byPath).toEqual({ quick: 'succeeded', slow: 'queued' })
  })
})
