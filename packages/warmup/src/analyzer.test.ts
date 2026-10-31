import { describe, expect, test } from 'bun:test'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { createWarmupAnalyzer, warmupOptionsSchema } from './analyzer.ts'
import { warmupReport } from './report.ts'

const clock = () => {
  let ms = Date.parse('2026-10-31T10:00:00Z')
  return () => {
    const at = new Date(ms)
    ms += 90_000
    return at
  }
}

describe('warmup analyzer', () => {
  test('runs the command with its env in the checkout and keeps the output tail', async () => {
    const { runner, calls } = createFakeRunner(() => ({
      stdout: Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n'),
      stderr: 'warning',
    }))
    const analyzer = createWarmupAnalyzer({ now: clock() })
    const options = warmupOptionsSchema.parse({
      command: 'yarn all',
      cwd: 'libs',
      env: { TURBO_TEAMID: 'my-team' },
      outputLines: 3,
      branch: 'main',
    })
    const { data, ref } = await analyzer.run({
      repo: { forge: 'work', path: 'games/libs' },
      dir: '/checkout',
      ref: 'abc123',
      runner,
      options,
    })
    expect(calls[0]?.command).toEqual(['sh', '-c', 'yarn all'])
    expect(calls[0]?.options.cwd).toBe('/checkout/libs')
    expect(calls[0]?.options.env).toEqual({ TURBO_TEAMID: 'my-team' })
    expect(ref).toBe('abc123')
    expect(data).toMatchObject({
      exitCode: 0,
      durationMs: 90_000,
      branch: 'main',
      output: 'line 3\nline 4\nwarning',
    })
  })

  test('a failing command is a result, not an error', async () => {
    const { runner } = createFakeRunner(() => ({ exitCode: 2, stderr: 'boom' }))
    const analyzer = createWarmupAnalyzer({ now: clock() })
    const { data } = await analyzer.run({
      repo: { forge: 'work', path: 'games/libs' },
      dir: '/checkout',
      runner,
      options: warmupOptionsSchema.parse({ command: 'false' }),
    })
    expect(data.exitCode).toBe(2)
    expect(warmupReport(data).metrics[0]).toMatchObject({ value: 'failed', tone: 'bad' })
  })

  test('rejects a missing command, paths outside the checkout and bad variable names', () => {
    expect(warmupOptionsSchema.safeParse({}).success).toBe(false)
    expect(warmupOptionsSchema.safeParse({ command: 'x', cwd: '../up' }).success).toBe(false)
    expect(warmupOptionsSchema.safeParse({ command: 'x', env: { 'A-B': '1' } }).success).toBe(false)
  })
})
