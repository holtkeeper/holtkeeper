import { describe, expect, test } from 'bun:test'

import type { AnyAnalyzer } from '@holtkeeper/analyzer'
import { createFakeRunner } from '@holtkeeper/exec/testing'
import type { Job } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { z } from 'zod'

import type { ContextFor } from './context.ts'
import { createWorker } from './worker.ts'

const { runner } = createFakeRunner()

const contextFor: ContextFor = async (job) => ({
  context: { repo: job.repo, runner },
  cleanup: async () => {},
})

const analyzer = (kind: string, run: AnyAnalyzer['run']): AnyAnalyzer => ({
  kind,
  analysis: { kind: `${kind}-data` } as AnyAnalyzer['analysis'],
  scope: 'repo',
  needs: {},
  options: z.object({}),
  run,
})

const until = async (check: () => boolean | Promise<boolean>, ms = 2000) => {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

describe('worker admission', () => {
  test('a refused job waits without a slot while other jobs run, then runs once admitted', async () => {
    const store = memoryStore()
    const order: string[] = []
    let saturated = true
    const asked: string[] = []
    const worker = createWorker({
      store,
      analyzers: [
        analyzer('ai', async () => {
          order.push('ai')
          return { data: {} }
        }),
        analyzer('size', async () => {
          order.push('size')
          return { data: {} }
        }),
      ],
      contextFor,
      concurrency: 1,
      pollMs: 5,
      admissionPollMs: 5,
      admission: (job: Job) => {
        asked.push(job.analyzer)
        return job.analyzer !== 'ai' || !saturated
      },
    })
    const enqueue = (kind: string, path: string) =>
      store.jobs.enqueue({
        analyzer: kind,
        repo: { forge: 'work', path },
        trigger: 'manual',
        createdAt: new Date().toISOString(),
      })
    const ai = await enqueue('ai', 'games/a')
    const size = await enqueue('size', 'games/b')

    await worker.start()
    await until(async () => (await store.jobs.get(size.id))?.status === 'succeeded')
    const waiting = await store.jobs.get(ai.id)
    expect(waiting).toMatchObject({ status: 'running', attempts: 1 })
    expect(waiting?.log).toContain('waiting for capacity')
    expect(order).toEqual(['size'])

    saturated = false
    await until(async () => (await store.jobs.get(ai.id))?.status === 'succeeded')
    expect(order).toEqual(['size', 'ai'])
    expect((await store.jobs.get(ai.id))?.attempts).toBe(1)
    expect(asked.filter((kind) => kind === 'ai').length).toBeGreaterThan(1)
    await worker.stop()
  })

  test('stops claiming once maxWaiting jobs wait', async () => {
    const store = memoryStore()
    const ran: string[] = []
    const worker = createWorker({
      store,
      analyzers: [
        analyzer('ai', async ({ repo }) => {
          ran.push(repo.path)
          return { data: {} }
        }),
      ],
      contextFor,
      concurrency: 2,
      maxWaiting: 1,
      pollMs: 5,
      admissionPollMs: 5,
      admission: () => false,
    })
    for (const path of ['games/a', 'games/b', 'games/c']) {
      await store.jobs.enqueue({
        analyzer: 'ai',
        repo: { forge: 'work', path },
        trigger: 'manual',
        createdAt: new Date().toISOString(),
      })
    }
    await worker.start()
    await new Promise((resolve) => setTimeout(resolve, 40))
    const running = await store.jobs.list({ status: 'running' })
    expect(running.map((job) => job.repo.path)).toEqual(['games/a'])
    expect(ran).toEqual([])
    await worker.stop()
    expect(await store.jobs.list({ status: 'running' })).toEqual([])
  })

  test('a throwing hook admits the job', async () => {
    const store = memoryStore()
    const worker = createWorker({
      store,
      analyzers: [analyzer('size', async () => ({ data: {} }))],
      contextFor,
      admission: () => {
        throw new Error('broken hook')
      },
    })
    const job = await store.jobs.enqueue({
      analyzer: 'size',
      repo: { forge: 'work', path: 'games/a' },
      trigger: 'manual',
      createdAt: new Date().toISOString(),
    })
    expect(await worker.runNext()).toMatchObject({ id: job.id, status: 'succeeded' })
  })
})
