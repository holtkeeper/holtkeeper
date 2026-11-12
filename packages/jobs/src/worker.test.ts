import { beforeEach, describe, expect, test } from 'bun:test'

import type { AnyAnalyzer } from '@holtkeeper/analyzer'
import { type ArtifactStore, memoryArtifactStore } from '@holtkeeper/artifacts'
import { createFakeRunner } from '@holtkeeper/exec/testing'
import type { AnalysisRecord, Job, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { z } from 'zod'

import type { ContextFor } from './context.ts'
import { readJobLog } from './log.ts'
import { createWorker, exponentialBackoff, isBudgetStop } from './worker.ts'

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
let logs: ArtifactStore
let clock: Date
let cleanups: number
const contextFor: ContextFor = async (job) => ({
  context: { repo: job.repo, runner, ...(job.ref ? { ref: job.ref } : {}) },
  cleanup: async () => {
    cleanups++
  },
})

const withSha: ContextFor = async (job, target, io) => ({
  ...(await contextFor(job, target, io)),
  ...(target.kind !== 'plain' && { sha: 'c0ffee01' }),
})

beforeEach(() => {
  store = memoryStore()
  logs = memoryArtifactStore()
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

const logLines = async (jobId: string, attempt = 1) =>
  (await readJobLog(logs, jobId, attempt, { tail: 2000 })).lines

const logText = async (jobId: string, attempt = 1) =>
  (await logLines(jobId, attempt)).map((line) => line.text)

describe('worker', () => {
  test('a worker claims only the jobs of the pools it serves', async () => {
    const ran: string[] = []
    const plain = analyzer('plain', async ({ repo }) => {
      ran.push(`plain:${repo.path}`)
      return { data: {} }
    })
    const shaper = analyzer(
      'shaper',
      async ({ repo }) => {
        ran.push(`shaper:${repo.path}`)
        return { data: {} }
      },
      { pool: 'write' },
    )
    await enqueue('shaper', { repo: { forge: 'work', path: 'games/b' } })
    await enqueue('plain')
    const general = createWorker({
      store,
      analyzers: [plain, shaper],
      contextFor,
      now: () => clock,
    })
    const writer = createWorker({
      store,
      analyzers: [plain, shaper],
      contextFor,
      pools: ['write'],
      now: () => clock,
    })

    await general.runNext()
    expect(await general.runNext()).toBeUndefined()
    await writer.runNext()
    expect(await writer.runNext()).toBeUndefined()
    expect(ran).toEqual(['plain:games/a', 'shaper:games/b'])
  })

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
      logs,
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
    expect(await logText(queued.id)).toContain('measuring')
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

  test('stores the metrics of the kind with the options and the previous record', async () => {
    const widgets: AnyAnalyzer['analysis'] = {
      kind: 'widgets',
      label: 'Widgets',
      schema: z.object({ count: z.number() }),
      summarize: () => [],
      toReport: () => {
        throw new Error('not used')
      },
      metrics: (
        data: { count: number },
        { options, previous }: { options?: unknown; previous?: { count: number } },
      ) => ({
        count: data.count,
        limit: z.object({ limit: z.number() }).parse(options).limit,
        ...(previous ? { delta: data.count - previous.count } : {}),
      }),
    }
    let count = 3
    const counter = analyzer('counter', async () => ({ data: { count } }), { analysis: widgets })
    const broken = analyzer('broken', async () => ({ data: { count: 'many' } }), {
      analysis: { ...widgets, kind: 'broken' },
    })
    const worker = createWorker({
      store,
      analyzers: [counter, broken],
      contextFor,
      now: () => clock,
    })
    await enqueue('counter', { options: { limit: 4 } })
    const first = await worker.runNext()
    expect((await store.analyses.get(first?.analysisId ?? ''))?.metrics).toEqual({
      count: 3,
      limit: 4,
    })
    count = 5
    clock = new Date(clock.getTime() + 60_000)
    await enqueue('counter')
    const second = await worker.runNext()
    expect((await store.analyses.get(second?.analysisId ?? ''))?.metrics).toEqual({
      count: 5,
      limit: 1,
      delta: 2,
    })
    await enqueue('broken')
    const unread = await worker.runNext()
    expect(unread?.status).toBe('succeeded')
    expect(await store.analyses.get(unread?.analysisId ?? '')).not.toHaveProperty('metrics')
  })

  test('keeps only the newest records of analyzers that ask for it', async () => {
    const snapshot = analyzer('snapshot', async () => ({ data: {} }), { keepRecords: 2 })
    const worker = createWorker({ store, analyzers: [snapshot], contextFor, now: () => clock })
    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      clock = new Date(clock.getTime() + 60_000)
      await enqueue('snapshot')
      ids.push((await worker.runNext())?.analysisId ?? 'missing')
    }
    const kept = await store.analyses.list({ kind: 'snapshot-data' })
    expect(kept.map((record) => record.id)).toEqual(ids.slice(2).toReversed())
  })

  test('records the checkout commit, or the commit the analyzer reports', async () => {
    const checkedOut = analyzer('checked', async () => ({ data: {} }))
    const reported = analyzer('reported', async () => ({ data: {}, sha: 'f00dfeed' }))
    const plain = analyzer('plain', async () => ({ data: {} }))
    const worker = createWorker({
      store,
      analyzers: [checkedOut, reported, plain],
      contextFor: withSha,
      now: () => clock,
    })
    const shaOf = async (kind: string) => {
      await enqueue(kind)
      const done = await worker.runNext()
      return (await store.analyses.get(done?.analysisId ?? ''))?.sha
    }
    expect(await shaOf('checked')).toBe('c0ffee01')
    expect(await shaOf('reported')).toBe('f00dfeed')
    expect(await shaOf('plain')).toBeUndefined()
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
      logs,
    })
    await enqueue('assets')
    const second = await failing.runNext()
    expect(second).toMatchObject({ status: 'succeeded' })
    const logged = await logText(second?.id ?? '')
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

  test('logs each attempt separately and records the step that failed', async () => {
    let attempt = 0
    const lint = analyzer('lint', async ({ step, log }) => {
      attempt++
      if (!step) throw new Error('no step helper')
      await step('install', async () => log?.('resolving widgets'))
      return step('check', async () => {
        if (attempt === 1) throw new Error(`3 problems in /tmp/run-${attempt}/widget.ts`)
        return { data: {} }
      })
    })
    const worker = createWorker({ store, analyzers: [lint], contextFor, logs, now: () => clock })
    const queued = await enqueue('lint', { maxAttempts: 2 })

    const failed = await worker.runNext()
    expect(failed).toMatchObject({
      status: 'queued',
      errorSignature: '<n> problems in <path>',
      attemptsHistory: [{ n: 1, status: 'failed', step: 'check' }],
    })
    const first = await logLines(queued.id, 1)
    expect(first.filter((line) => line.mark).map((line) => `${line.mark} ${line.step}`)).toEqual([
      'start prepare',
      'end prepare',
      'start analyze',
      'start install',
      'end install',
      'start check',
      'fail check',
      'fail analyze',
    ])
    expect(first.find((line) => line.text === 'resolving widgets')?.step).toBe('install')
    expect(first.at(-1)).toMatchObject({ level: 'error', text: expect.stringMatching(/^failed: /) })

    clock = new Date('2026-10-30T10:01:00.000Z')
    const done = await worker.runNext()
    expect(done?.attemptsHistory.map((a) => a.status)).toEqual(['failed', 'succeeded'])
    expect(done?.errorSignature).toBeUndefined()
    expect(await logText(queued.id, 2)).toContain('resolving widgets')
    expect((await readJobLog(logs, queued.id, 2)).complete).toBeTrue()
  })

  test('a budget stop blocks the job without retry', async () => {
    const finished: Job[] = []
    const budget = Object.assign(new Error('AI budget exceeded: week of 2026-10-26'), {
      name: 'BudgetExceededError',
    })
    const worker = createWorker({
      store,
      analyzers: [
        analyzer('pricey', async () =>
          Promise.reject(new Error('review failed', { cause: budget })),
        ),
      ],
      contextFor,
      now: () => clock,
      onFinished: (job) => {
        finished.push(job)
      },
    })
    await enqueue('pricey', { maxAttempts: 3 })
    expect(await worker.runNext()).toMatchObject({
      status: 'blocked',
      attempts: 1,
      error: 'review failed',
    })
    expect(finished.map((j) => j.status)).toEqual(['blocked'])
    expect(await worker.runNext()).toBeUndefined()
  })

  test('isBudgetStop looks through the cause chain', () => {
    const budget = Object.assign(new Error('x'), { name: 'BudgetExceededError' })
    expect(isBudgetStop(budget)).toBeTrue()
    expect(isBudgetStop(new Error('y', { cause: new Error('z', { cause: budget }) }))).toBeTrue()
    expect(isBudgetStop(new Error('rate limited'))).toBeFalse()
    expect(isBudgetStop('BudgetExceededError')).toBeFalse()
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
      logs,
      now: () => clock,
      heartbeatMs: 5,
    })
    const queued = await enqueue('slow')
    const result = worker.runNext()
    await running
    await store.jobs.cancel(queued.id, clock.toISOString())
    expect(await result).toMatchObject({ status: 'canceled' })
    expect(await store.analyses.list()).toEqual([])
    expect((await logText(queued.id)).at(-1)).toBe('canceled')
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

  test('claims by the exclusive and after declarations of its analyzers', async () => {
    const gates = new Map<string, () => void>()
    const hold = (kind: string, overrides: Partial<AnyAnalyzer> = {}) =>
      analyzer(
        kind,
        () =>
          new Promise((resolve) => {
            gates.set(kind, () => resolve({ data: {} }))
          }),
        overrides,
      )
    const worker = createWorker({
      store,
      analyzers: [
        hold('lint'),
        hold('changelog'),
        hold('fix', { exclusive: true }),
        hold('risk', { after: ['changelog'] }),
      ],
      contextFor,
      now: () => clock,
      concurrency: 4,
      pollMs: 5,
    })
    const lint = await enqueue('lint')
    const changelog = await enqueue('changelog')
    const risk = await enqueue('risk')
    const fix = await enqueue('fix')
    const status = async () =>
      Promise.all(
        [lint, changelog, risk, fix].map(async (job) => (await store.jobs.get(job.id))?.status),
      )

    await worker.start()
    await Bun.sleep(30)
    expect(await status()).toEqual(['running', 'running', 'queued', 'queued'])
    gates.get('changelog')?.()
    await Bun.sleep(30)
    expect(await status()).toEqual(['running', 'succeeded', 'running', 'queued'])
    gates.get('lint')?.()
    gates.get('risk')?.()
    await Bun.sleep(30)
    expect(await status()).toEqual(['succeeded', 'succeeded', 'succeeded', 'running'])
    gates.get('fix')?.()
    await worker.stop()
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

test('a running job whose worker died is recovered while the worker runs, not only on start', async () => {
  const done = Promise.withResolvers<void>()
  const size = analyzer('size', async () => {
    done.resolve()
    return { data: {} }
  })
  const queued = await enqueue('size')
  expect(await store.jobs.claim('dead-worker', clock.toISOString())).toMatchObject({
    id: queued.id,
  })
  const lines: string[] = []
  const worker = createWorker({
    store,
    analyzers: [size],
    contextFor,
    now: () => clock,
    staleMs: 20,
    pollMs: 60_000,
    log: (line) => lines.push(line),
  })
  await worker.start()
  expect((await store.jobs.get(queued.id))?.status).toBe('running')
  clock = new Date(clock.getTime() + 60_000)
  await done.promise
  await worker.stop()
  expect(lines).toContain(`recovered job ${queued.id} (queued)`)
})

test('a job recovery fails for good is reported as finished', async () => {
  const size = analyzer('size', async () => ({ data: {} }))
  const lost = await enqueue('size', { maxAttempts: 1 })
  await store.jobs.claim('dead-worker', clock.toISOString())
  clock = new Date(clock.getTime() + 60_000)
  const finished: string[] = []
  const worker = createWorker({
    store,
    analyzers: [size],
    contextFor,
    now: () => clock,
    staleMs: 20,
    pollMs: 60_000,
    onFinished: (job) => {
      finished.push(`${job.id} ${job.status}`)
    },
  })
  await worker.start()
  await worker.stop()
  expect(finished).toEqual([`${lost.id} failed`])
})
