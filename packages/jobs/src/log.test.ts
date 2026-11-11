import { describe, expect, test } from 'bun:test'

import { type ArtifactStore, memoryArtifactStore } from '@holtkeeper/artifacts'

import { createJobLog, readJobLog, stepsOf } from './log.ts'

const clock = () => {
  let ms = Date.parse('2026-10-30T10:00:00.000Z')
  return () => new Date((ms += 1000))
}

const chunkCount = async (store: ArtifactStore, jobId: string, attempt = 1) =>
  (await store.getRef(`job-logs/${jobId}/${attempt}/head`))?.meta?.chunks

describe('job log', () => {
  test('stores a chunk every flushLines lines and the rest on close', async () => {
    const store = memoryArtifactStore()
    const log = createJobLog(store, { jobId: 'j1', attempt: 1, flushLines: 3, flushMs: 60_000 })
    for (let i = 0; i < 7; i++) log.write(`line ${i}`)
    await log.flush()
    expect(await chunkCount(store, 'j1')).toBe(3)
    expect((await readJobLog(store, 'j1', 1)).complete).toBeFalse()

    await log.close()
    log.write('after close')
    await log.flush()
    const page = await readJobLog(store, 'j1', 1)
    expect(page).toMatchObject({ total: 7, offset: 0, complete: true })
    expect(page.lines.map((line) => line.text)).toEqual(
      Array.from({ length: 7 }, (_, i) => `line ${i}`),
    )
    expect(page.lines.map((line) => line.n)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  test('flushes buffered lines after flushMs', async () => {
    const store = memoryArtifactStore()
    const log = createJobLog(store, { jobId: 'j1', attempt: 2, flushLines: 100, flushMs: 5 })
    log.write('one')
    log.write('two')
    expect((await readJobLog(store, 'j1', 2)).total).toBe(0)
    await Bun.sleep(30)
    expect((await readJobLog(store, 'j1', 2)).lines.map((line) => line.text)).toEqual([
      'one',
      'two',
    ])
    await log.close()
  })

  test('pages by offset and tail across chunks', async () => {
    const store = memoryArtifactStore()
    const log = createJobLog(store, { jobId: 'j1', attempt: 1, flushLines: 4 })
    for (let i = 0; i < 50; i++) log.write(`line ${i}`)
    await log.close()

    const middle = await readJobLog(store, 'j1', 1, { offset: 13, limit: 10 })
    expect(middle.offset).toBe(13)
    expect(middle.lines.map((line) => line.n)).toEqual([13, 14, 15, 16, 17, 18, 19, 20, 21, 22])
    const tail = await readJobLog(store, 'j1', 1, { tail: 3 })
    expect(tail).toMatchObject({ total: 50, offset: 47 })
    expect(tail.lines.map((line) => line.text)).toEqual(['line 47', 'line 48', 'line 49'])
    expect((await readJobLog(store, 'j1', 1, { offset: 60 })).lines).toEqual([])
    expect(await readJobLog(store, 'j1', 9)).toEqual({
      total: 0,
      offset: 0,
      lines: [],
      complete: false,
      steps: [],
    })
  })

  test('steps mark start and end, tag their lines and remember the failing step', async () => {
    const store = memoryArtifactStore()
    const log = createJobLog(store, { jobId: 'j1', attempt: 1, now: clock() })
    await log.step('install', async () => log.write('resolving'))
    const boom = new Error('lockfile is out of date')
    const failed = log.step('analyze', () =>
      log.step('lint', async () => {
        log.write('checking')
        throw boom
      }),
    )
    expect(failed).rejects.toBe(boom)
    await failed.catch(() => {})
    expect(log.failedStep).toBe('lint')
    log.write('failed: lockfile is out of date', { level: 'error' })
    await log.close()

    const lines = (await readJobLog(store, 'j1', 1)).lines
    expect(
      lines.map(({ text, step, mark, ms, level }) => ({ text, step, mark, ms, level })),
    ).toEqual([
      { text: 'install', step: 'install', mark: 'start', ms: undefined, level: undefined },
      { text: 'resolving', step: 'install', mark: undefined, ms: undefined, level: undefined },
      { text: 'install', step: 'install', mark: 'end', ms: 3000, level: undefined },
      { text: 'analyze', step: 'analyze', mark: 'start', ms: undefined, level: undefined },
      { text: 'lint', step: 'lint', mark: 'start', ms: undefined, level: undefined },
      { text: 'checking', step: 'lint', mark: undefined, ms: undefined, level: undefined },
      {
        text: 'lint failed: lockfile is out of date',
        step: 'lint',
        mark: 'fail',
        ms: 3000,
        level: 'error',
      },
      {
        text: 'analyze failed: lockfile is out of date',
        step: 'analyze',
        mark: 'fail',
        ms: 7000,
        level: 'error',
      },
      {
        text: 'failed: lockfile is out of date',
        step: undefined,
        mark: undefined,
        ms: undefined,
        level: 'error',
      },
    ])
    const steps = (await readJobLog(store, 'j1', 1, { tail: 1 })).steps
    expect(
      steps.map(({ name, depth, line, status, ms }) => ({ name, depth, line, status, ms })),
    ).toEqual([
      { name: 'install', depth: 0, line: 0, status: 'succeeded', ms: 3000 },
      { name: 'analyze', depth: 0, line: 3, status: 'failed', ms: 7000 },
      { name: 'lint', depth: 1, line: 4, status: 'failed', ms: 3000 },
    ])
  })

  test('stepsOf leaves unfinished steps running and ignores marks without a start', () => {
    const at = '2026-01-02T03:04:05.000Z'
    expect(
      stepsOf([
        { n: 0, at, mark: 'end', step: 'lost', ms: 5 },
        { n: 1, at, mark: 'start', step: 'checkout' },
        { n: 2, at, mark: 'end', step: 'checkout', ms: 40 },
        { n: 3, at, mark: 'start', step: 'analyze' },
      ]),
    ).toEqual([
      { name: 'checkout', depth: 0, line: 1, startedAt: at, status: 'succeeded', ms: 40 },
      { name: 'analyze', depth: 0, line: 3, startedAt: at, status: 'running' },
    ])
  })

  test('a step failing with its own error after a caught one becomes the failing step', async () => {
    const log = createJobLog(memoryArtifactStore(), { jobId: 'j1', attempt: 1 })
    await log.step('optional', () => Promise.reject(new Error('skipped'))).catch(() => {})
    await log.step('store', () => Promise.reject(new Error('disk full'))).catch(() => {})
    expect(log.failedStep).toBe('store')
    await log.close()
  })

  test('keeps lines whose chunk failed to store for the next flush', async () => {
    const inner = memoryArtifactStore()
    let broken = true
    const errors: unknown[] = []
    const store: ArtifactStore = {
      ...inner,
      put: (data, options) =>
        broken ? Promise.reject(new Error('bucket offline')) : inner.put(data, options),
    }
    const log = createJobLog(store, {
      jobId: 'j1',
      attempt: 1,
      onError: (error) => errors.push(error),
    })
    log.write('one')
    await log.flush()
    expect(errors).toHaveLength(1)
    broken = false
    log.write('two')
    await log.close()
    expect((await readJobLog(inner, 'j1', 1)).lines.map((line) => line.text)).toEqual([
      'one',
      'two',
    ])
  })

  test('retries the last chunk on close until it is stored', async () => {
    const inner = memoryArtifactStore()
    let failures = 2
    const store: ArtifactStore = {
      ...inner,
      put: (data, options) =>
        failures-- > 0 ? Promise.reject(new Error('bucket offline')) : inner.put(data, options),
    }
    const log = createJobLog(store, { jobId: 'j1', attempt: 1, onError: () => {} })
    log.write('last words')
    await log.close()
    const page = await readJobLog(inner, 'j1', 1)
    expect(page.lines.map((line) => line.text)).toEqual(['last words'])
    expect(page.complete).toBe(true)
  })

  test('drops lines beyond maxLines behind one notice', async () => {
    const store = memoryArtifactStore()
    const log = createJobLog(store, { jobId: 'j1', attempt: 1, maxLines: 3 })
    for (let i = 0; i < 10; i++) log.write(`line ${i}`)
    await log.close()
    expect((await readJobLog(store, 'j1', 1)).lines.map((line) => line.text)).toEqual([
      'line 0',
      'line 1',
      'line 2',
      'log truncated after 3 lines',
    ])
  })
})
