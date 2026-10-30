import { beforeEach, describe, expect, test } from 'bun:test'

import type { AnyAnalyzer } from '@holtkeeper/analyzer'
import { createFakeRunner } from '@holtkeeper/exec/testing'
import type { AnalysisRecord, Job, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { z } from 'zod'

import type { ContextFor } from './context.ts'
import { createWorker, exponentialBackoff } from './worker.ts'

const { runner } = createFakeRunner()

const analyzer = (
  kind: string,
  run: AnyAnalyzer['run'],
  overrides: Partial<AnyAnalyzer> = {},
): AnyAnalyzer => ({
  kind,
  analysis: { kind: `${kind}-data` } as AnyAnalyzer['analysis'],
  scope: 'repo',
  needs: {},
  options: z.object({ limit: z.coerce.number().default(1) }),
  run,
  ...overrides,
})

let store: Store
let clock: Date
let cleanups: number
const contextFor: ContextFor = async (job) => ({
  context: { repo: job.repo, runner, ...(job.ref ? { ref: job.ref } : {}) },
  cleanup: async () => {
    cleanups++
  },
})

beforeEach(() => {
  store = memoryStore()
  clock = new Date('2026-10-30T10:00:00.000Z')
  cleanups = 0
})

const enqueue = (
  analyzerKind: string,
  extra: Partial<Parameters<Store['jobs']['enqueue']>[0]> = {},
) =>
  store.jobs.enqueue({
    analyzer: analyzerKind,
    repo: { forge: 'work', path: 'games/a' },
    trigger: 'manual',
    createdAt: clock.toISOString(),
    ...extra,
  })

describe('worker', () => {
  test('runs an analyzer, stores the record and completes the job', async () => {
    const finished: [Job, AnalysisRecord | undefined][] = []
    const size = analyzer('size', async ({ options, ref, log }) => {
      log?.('measuring')
      return { data: { limit: options.limit, ref }, ref: 'v2' }
    })
    const worker = createWorker({
      store,
      analyzers: [size],
      contextFor,
      now: () => clock,
      onFinished: (job, record) => {
        finished.push([job, record])
      },
    })
    const queued = await enqueue('size', { ref: 'v1', options: { limit: '5' }, actor: 'jane' })

    const done = await worker.runNext()
    expect(done).toMatchObject({ id: queued.id, status: 'succeeded' })
    const record = await store.analyses.get(done?.analysisId ?? '')
    expect(record).toMatchObject({
      kind: 'size-data',
      repo: { forge: 'work', path: 'games/a' },
      ref: 'v2',
      actor: 'jane',
      data: { limit: 5, ref: 'v1' },
    })
    expect((await store.jobs.get(queued.id))?.log).toContain('measuring')
    expect(finished.map(([job, rec]) => [job.status, rec?.id])).toEqual([['succeeded', record?.id]])
    expect(cleanups).toBe(1)
    expect(await worker.runNext()).toBeUndefined()
  })

  test('records the analysis at the time the analyzer returns', async () => {
    const release = analyzer('release', async () => ({ data: {}, at: '2026-01-15T09:00:00Z' }))
    const plain = analyzer('plain', async () => ({ data: {} }))
    const worker = createWorker({
      store,
      analyzers: [release, plain],
      contextFor,
      now: () => clock,
    })
    await enqueue('release')
    const past = await worker.runNext()
    expect((await store.analyses.get(past?.analysisId ?? ''))?.createdAt).toBe(
      '2026-01-15T09:00:00Z',
    )
    await enqueue('plain')
    const now = await worker.runNext()
    expect((await store.analyses.get(now?.analysisId ?? ''))?.createdAt).toBe(clock.toISOString())
  })

  test('persists returned artifacts after the record, tagged with it; failures are logged', async () => {
    const artifact = { id: 'a'.repeat(64), data: new Uint8Array([1, 2]), contentType: 'image/webp' }
    const optimize = analyzer('assets', async () => ({ data: {}, artifacts: [artifact] }))
    const persisted: unknown[] = []
    const worker = createWorker({
      store,
      analyzers: [optimize],
      contextFor,
      now: () => clock,
      persistArtifacts: async (artifacts, context) => {
        expect(await store.analyses.get(context.analysisId)).toBeDefined()
        persisted.push([artifacts, context])
      },
    })
    await enqueue('assets')
    const done = await worker.runNext()
    expect(persisted).toEqual([
      [
        [artifact],
        {
          repo: { forge: 'work', path: 'games/a' },
          kind: 'assets-data',
          analysisId: done?.analysisId,
        },
      ],
    ])

    const failing = createWorker({
      store,
      analyzers: [optimize],
      contextFor,
      now: () => clock,
      persistArtifacts: async () => {
        throw new Error('disk full')
      },
    })
    await enqueue('assets')
    const second = await failing.runNext()
    expect(second).toMatchObject({ status: 'succeeded' })
    const logged = (await store.jobs.get(second?.id ?? ''))?.log ?? []
    expect(logged.some((line) => line.includes('storing artifacts failed: disk full'))).toBe(true)
  })

  test('retries failures with exponential backoff, then fails for good', async () => {
    const finished: Job[] = []
    const worker = createWorker({
      store,
      analyzers: [analyzer('flaky', async () => Promise.reject(new Error('network down')))],
      contextFor,
      now: () => clock,
      onFinished: (job) => {
        finished.push(job)
      },
    })
    const queued = await enqueue('flaky', { maxAttempts: 2 })

    const first = await worker.runNext()
    expect(first).toMatchObject({
      status: 'queued',
      error: 'network down',
      runAfter: '2026-10-30T10:01:00.000Z',
    })
    expect(await worker.runNext()).toBeUndefined()
    clock = new Date('2026-10-30T10:01:00.000Z')
    expect(await worker.runNext()).toMatchObject({ id: queued.id, status: 'failed', attempts: 2 })
    expect(finished.map((j) => j.status)).toEqual(['failed'])
    expect(cleanups).toBe(2)
  })

  test('unknown analyzers and invalid options fail without retry', async () => {
    const worker = createWorker({
      store,
      analyzers: [analyzer('size', async () => ({ data: {} }))],
      contextFor,
      now: () => clock,
    })
    await enqueue('missing')
    expect(await worker.runNext()).toMatchObject({
      status: 'failed',
      error: 'unknown analyzer "missing"',
    })
    await enqueue('size', { repo: { forge: 'work', path: 'games/b' }, options: { limit: 'many' } })
    const invalid = await worker.runNext()
    expect(invalid?.status).toBe('failed')
    expect(invalid?.error).toContain('invalid options for size: limit')
  })

  test('aborts runs that exceed the timeout', async () => {
    let aborted = false
    const slow = analyzer('slow', ({ signal }) => {
      signal?.addEventListener('abort', () => {
        aborted = true
      })
      return new Promise(() => {})
    })
    const worker = createWorker({
      store,
      analyzers: [slow],
      contextFor,
      now: () => clock,
      timeoutMs: 20,
    })
    await enqueue('slow', { maxAttempts: 1 })
    const job = await worker.runNext()
    expect(job).toMatchObject({ status: 'failed' })
    expect(job?.error).toContain('timed out')
    expect(aborted).toBeTrue()
    expect(cleanups).toBe(1)
  })

  test('a canceled job stops at the next heartbeat and stores nothing', async () => {
    let started!: () => void
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    const slow = analyzer('slow', () => {
      started()
      return new Promise(() => {})
    })
    const worker = createWorker({
      store,
      analyzers: [slow],
      contextFor,
      now: () => clock,
      heartbeatMs: 5,
    })
    const queued = await enqueue('slow')
    const result = worker.runNext()
    await running
    await store.jobs.cancel(queued.id, clock.toISOString())
    expect(await result).toMatchObject({ status: 'canceled' })
    expect(await store.analyses.list()).toEqual([])
    expect((await store.jobs.get(queued.id))?.log.at(-1)).toBe('canceled')
  })

  test('start recovers stale jobs, runs up to concurrency, stop requeues running jobs', async () => {
    const stale = await enqueue('slow', { repo: { forge: 'work', path: 'games/stale' } })
    await store.jobs.claim('dead-worker', '2026-10-30T09:00:00.000Z')

    let concurrent = 0
    let peak = 0
    const slow = analyzer('slow', ({ signal }) => {
      concurrent++
      peak = Math.max(peak, concurrent)
      return new Promise((_, reject) => {
        signal?.addEventListener('abort', () => {
          concurrent--
          reject(new Error('aborted'))
        })
      })
    })
    for (const path of ['games/a', 'games/b', 'games/c'])
      await enqueue('slow', { repo: { forge: 'work', path } })

    const worker = createWorker({
      store,
      analyzers: [slow],
      contextFor,
      now: () => clock,
      concurrency: 2,
      pollMs: 5,
    })
    await worker.start()
    await Bun.sleep(30)
    expect(peak).toBe(2)
    expect((await store.jobs.get(stale.id))?.status).not.toBe('failed')
    await worker.stop()

    const all = await store.jobs.list()
    expect(all.filter((j) => j.status === 'running')).toEqual([])
    expect(all.filter((j) => j.status === 'queued')).toHaveLength(4)
    expect(all.every((j) => j.runAfter <= clock.toISOString())).toBeTrue()
  })

  test('merges defaults, schedule options, the scoped setting and manual options in order', async () => {
    const seen: unknown[] = []
    const merge = analyzer(
      'merge',
      async ({ options }) => {
        seen.push(options)
        return { data: {} }
      },
      {
        options: z.object({
          a: z.string().default('default'),
          b: z.string().default('default'),
          c: z.string().default('default'),
        }),
      },
    )
    const worker = createWorker({
      store,
      analyzers: [merge],
      contextFor,
      now: () => clock,
      settingOptions: async (job) =>
        job.repo.path === 'games/bad' ? { a: 1 } : { b: 'setting', c: 'setting' },
    })
    await enqueue('merge', { trigger: 'schedule', options: { b: 'schedule' } })
    await worker.runNext()
    await enqueue('merge', { repo: { forge: 'work', path: 'games/m' }, options: { c: 'manual' } })
    await worker.runNext()
    expect(seen).toEqual([
      { a: 'default', b: 'setting', c: 'setting' },
      { a: 'default', b: 'setting', c: 'manual' },
    ])
    await enqueue('merge', { repo: { forge: 'work', path: 'games/bad' } })
    const bad = await worker.runNext()
    expect(bad).toMatchObject({ status: 'failed', attempts: 1 })
    expect(bad?.error).toContain('invalid options for merge: a')
  })

  test('exponentialBackoff doubles from one minute up to an hour', () => {
    expect([1, 2, 3, 10].map(exponentialBackoff)).toEqual([60_000, 120_000, 240_000, 3_600_000])
  })
})
