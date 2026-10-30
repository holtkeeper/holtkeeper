import { describe, expect, test } from 'bun:test'

import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { ServerOptions } from '@holtkeeper/server'

import { UsageError } from '../src/audit.ts'
import { parseDuration, serve, serveOptions } from '../src/serve.ts'

const failure = (promise: Promise<unknown>) => promise.catch((error: unknown) => error)

describe('serve options', () => {
  test('flags win over the environment; defaults to all', async () => {
    expect(await serveOptions({}, {})).toEqual({ roles: ['all'] })
    expect(await serveOptions({}, { HOLTKEEPER_ROLE: 'worker', HOLTKEEPER_MAX_JOBS: '1' })).toEqual(
      {
        roles: ['worker'],
        worker: { maxJobs: 1 },
      },
    )
    expect(
      await serveOptions(
        { role: 'web,scheduler', concurrency: '4', 'drain-timeout': '2m' },
        { HOLTKEEPER_ROLE: 'worker' },
      ),
    ).toEqual({ roles: ['web', 'scheduler'], worker: { concurrency: 4 }, drainTimeoutMs: 120_000 })
  })

  test('rejects bad values as usage errors', async () => {
    expect(await failure(serveOptions({ role: 'boss' }, {}))).toBeInstanceOf(UsageError)
    expect(await failure(serveOptions({ 'max-jobs': '0' }, {}))).toBeInstanceOf(UsageError)
    expect(() => parseDuration('drain-timeout', 'soon')).toThrow(UsageError)
    expect(parseDuration('drain-timeout', '45')).toBe(45_000)
    expect(parseDuration('drain-timeout', '500ms')).toBe(500)
  })
})

describe('serve', () => {
  const config = {} as HoltkeeperConfig

  test('exits 0 once the worker reached --max-jobs, after stopping the server', async () => {
    const events: string[] = []
    const exhausted = Promise.withResolvers<void>()
    let received: ServerOptions | undefined
    const code = serve(
      config,
      { roles: ['worker'], worker: { maxJobs: 1 } },
      async (_config, options) => {
        received = options
        return {
          url: 'http://test',
          exhausted: exhausted.promise,
          stop: async () => {
            events.push('stopped')
          },
        }
      },
      () => new Promise<void>(() => {}),
      (line) => events.push(line),
    )
    await Bun.sleep(1)
    expect(events).toEqual([])
    exhausted.resolve()
    expect(await code).toBe(0)
    expect(events).toEqual(['max jobs reached; shutting down', 'stopped'])
    expect(received?.worker).toEqual({ maxJobs: 1 })
  })

  test('stops on a signal', async () => {
    const events: string[] = []
    const code = await serve(
      config,
      {},
      async () => ({
        url: 'http://test',
        exhausted: new Promise<void>(() => {}),
        stop: async () => {
          events.push('stopped')
        },
      }),
      async () => {},
      (line) => events.push(line),
    )
    expect(code).toBe(0)
    expect(events).toEqual(['shutting down', 'stopped'])
  })
})
