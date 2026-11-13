import { describe, expect, test } from 'bun:test'

import type { AnyAnalyzer } from '@holtkeeper/analyzer'
import { createFakeRunner } from '@holtkeeper/exec/testing'
import type { Job } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { z } from 'zod'

import type { ContextFor } from './context.ts'
import { type WorkerOptions, createWorker } from './worker.ts'

const { runner } = createFakeRunner()

const contextFor: ContextFor = async (job) => ({
  context: { repo: job.repo, runner },
  cleanup: async () => {},
})

const until = async (check: () => boolean | Promise<boolean>, ms = 2000) => {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

function setup(overrides: Partial<WorkerOptions> = {}, extra: Partial<AnyAnalyzer>[] = []) {
  const store = memoryStore()
  const gates = new Map<string, () => void>()
  const started: string[] = []
  const analyzer = (kind: string, fields: Partial<AnyAnalyzer> = {}): AnyAnalyzer => ({
    kind,
    analysis: { kind: `${kind}-data` } as AnyAnalyzer['analysis'],
    scope: 'repo',
    needs: {},
    options: z.object({}),
    async run({ repo }) {
      started.push(`${kind}:${repo.path}`)
      await new Promise<void>((resolve) => gates.set(`${kind}:${repo.path}`, resolve))
      return { data: {} }
    },
    ...fields,
  })
  const worker = createWorker({
    store,
    analyzers: [
      analyzer('widgets'),
      analyzer('answer', { interactive: true }),
      ...extra.map((fields) => analyzer(fields.kind ?? 'other', fields)),
    ],
    contextFor,
    concurrency: 1,
    pollMs: 5,
    ...overrides,
  })
  const enqueue = (kind: string, path: string, createdAt = new Date().toISOString()) =>
    store.jobs.enqueue({
      analyzer: kind,
      repo: { forge: 'work', path },
      trigger: 'manual',
      createdAt,
    })
  const status = async (job: Job) => (await store.jobs.get(job.id))?.status
  const release = (key: string) => gates.get(key)?.()
  return { store, worker, started, enqueue, status, release }
}

describe('worker express lane', () => {
  test('an interactive job runs at once while every regular slot is busy', async () => {
    const { worker, started, enqueue, status, release } = setup()
    await enqueue('widgets', 'shapes/a')
    const waiting = await enqueue('widgets', 'shapes/b')
    await worker.start()
    await until(() => started.length === 1)

    const answer = await enqueue('answer', 'shapes/c')
    await until(() => started.includes('answer:shapes/c'))
    expect(worker.running).toBe(2)
    expect(await status(waiting)).toBe('queued')

    release('answer:shapes/c')
    await until(async () => (await status(answer)) === 'succeeded')
    await settle()
    expect(await status(waiting)).toBe('queued')
    release('widgets:shapes/a')
    await until(() => started.includes('widgets:shapes/b'))
    release('widgets:shapes/b')
    await worker.stop()
  })

  test('an interactive job takes a free regular slot before older jobs, and only one express slot', async () => {
    const { worker, started, enqueue, status } = setup()
    const old = await enqueue('widgets', 'shapes/a', '2026-01-01T00:00:00.000Z')
    await enqueue('answer', 'shapes/b')
    await enqueue('answer', 'shapes/c')
    const third = await enqueue('answer', 'shapes/d')
    await worker.start()
    await until(() => started.length === 2)
    await settle()

    expect(started).toEqual(['answer:shapes/b', 'answer:shapes/c'])
    expect(await status(old)).toBe('queued')
    expect(await status(third)).toBe('queued')
    await worker.stop()
  })

  test('other jobs never take an express slot', async () => {
    const { worker, started, enqueue } = setup({ prioritySlots: 3 })
    for (const path of ['shapes/a', 'shapes/b', 'shapes/c']) await enqueue('widgets', path)
    await worker.start()
    await until(() => started.length === 1)
    await settle()
    expect(started).toHaveLength(1)
    await worker.stop()
  })

  test('prioritySlots 0 turns the lane off', async () => {
    const { worker, started, enqueue } = setup({ prioritySlots: 0 })
    await enqueue('widgets', 'shapes/a')
    await worker.start()
    await until(() => started.length === 1)
    await enqueue('answer', 'shapes/b')
    await settle()
    expect(started).toEqual(['widgets:shapes/a'])
    await worker.stop()
  })

  test('a claim delay does not hold back an interactive job', async () => {
    const { worker, started, enqueue } = setup({ claimDelayMs: 60 * 60_000 })
    await enqueue('widgets', 'shapes/a')
    await enqueue('answer', 'shapes/b')
    await worker.start()
    await until(() => started.length === 1)
    await settle()
    expect(started).toEqual(['answer:shapes/b'])
    await worker.stop()
  })

  test('the lane serves only interactive kinds of the worker pools', async () => {
    const { worker, started, enqueue } = setup({ pools: ['write'] }, [
      { kind: 'shaper', pool: 'write' },
      { kind: 'reply', pool: 'write', interactive: true },
    ])
    await enqueue('shaper', 'shapes/a')
    await worker.start()
    await until(() => started.length === 1)
    await enqueue('answer', 'shapes/b')
    await enqueue('reply', 'shapes/c')
    await until(() => started.length === 2)
    await settle()
    expect(started).toEqual(['shaper:shapes/a', 'reply:shapes/c'])
    await worker.stop()
  })

  test('an express job waits for admission in its own slot and counts toward maxJobs', async () => {
    let admitted = false
    const { worker, started, enqueue, status, release } = setup({
      admissionPollMs: 5,
      maxJobs: 2,
      admission: (job) => job.analyzer !== 'answer' || admitted,
    })
    await enqueue('widgets', 'shapes/a')
    await worker.start()
    await until(() => started.length === 1)
    const answer = await enqueue('answer', 'shapes/b')
    await until(async () => (await status(answer)) === 'running')
    const late = await enqueue('answer', 'shapes/c')
    await settle()
    expect(started).toEqual(['widgets:shapes/a'])

    admitted = true
    await until(() => started.includes('answer:shapes/b'))
    release('answer:shapes/b')
    release('widgets:shapes/a')
    await worker.exhausted
    expect(await status(late)).toBe('queued')
    await worker.stop()
  })

  test('an interactive job takes the express lane while maxWaiting jobs wait for admission', async () => {
    const { worker, started, enqueue, status, release } = setup({
      concurrency: 2,
      maxWaiting: 1,
      admissionPollMs: 5,
      admission: (job) => job.analyzer !== 'widgets',
    })
    const held = await enqueue('widgets', 'shapes/a')
    const behind = await enqueue('widgets', 'shapes/b')
    await worker.start()
    await until(async () => (await status(held)) === 'running')

    await enqueue('answer', 'shapes/c')
    await until(() => started.includes('answer:shapes/c'))
    expect(await status(behind)).toBe('queued')
    expect(worker.running).toBe(2)
    release('answer:shapes/c')
    await worker.drain(1000)
  })

  test('drain requeues an express job still waiting for admission', async () => {
    const { worker, started, enqueue, status, release } = setup({
      admissionPollMs: 5,
      admission: (job) => job.analyzer !== 'answer',
    })
    await enqueue('widgets', 'shapes/a')
    await worker.start()
    await until(() => started.length === 1)
    const answer = await enqueue('answer', 'shapes/b')
    await until(async () => (await status(answer)) === 'running')

    const drained = worker.drain(1000)
    await settle()
    release('widgets:shapes/a')
    expect(await drained).toEqual({ finished: 1, requeued: 1 })
    expect(await status(answer)).toBe('queued')
  })
})
