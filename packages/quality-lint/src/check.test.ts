import { describe, expect, test } from 'bun:test'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { lintCheck } from './check.ts'
import type { LinterAdapter } from './types.ts'

const adapter = (name: string, detected = true): LinterAdapter => ({
  name,
  detect: async () => detected,
  command: () => [name, 'lint'],
  parse: async (stdout) => ({
    issues: stdout
      ? [
          {
            id: `${name}-1`,
            tool: name,
            rule: 'r',
            category: 'lint',
            severity: 'warning',
            message: stdout,
          },
        ]
      : [],
    changes: [],
  }),
})

describe('lintCheck', () => {
  test('runs detected and installed linters and records versions', async () => {
    const { runner, calls } = createFakeRunner((command) => {
      if (command[1] === '--version')
        return command[0] === 'missing'
          ? { exitCode: 127 }
          : { stdout: `Version: 1.2.${command[0]?.length}\n` }
      return { exitCode: 1, stdout: `${command[0]} found something` }
    })
    const check = lintCheck({
      adapters: [adapter('one'), adapter('off', false), adapter('missing'), adapter('three')],
    })
    expect(check.name).toBe('lint')
    expect(await check.detect('/p')).toBe(true)

    const result = await check.run({ dir: '/p', runner })
    expect(result.version).toBe('one 1.2.3, three 1.2.5, missing (not installed)')
    expect(result.issues?.map((issue) => issue.message)).toEqual([
      'one found something',
      'three found something',
    ])
    expect(calls.map((call) => call.command.join(' '))).toEqual([
      'one --version',
      'one lint',
      'missing --version',
      'three --version',
      'three lint',
    ])
    expect(calls.every((call) => call.options.cwd === '/p')).toBe(true)
  })

  test('is skipped when no configured linter can start', async () => {
    const runner = {
      run: async () => {
        throw new Error('command not found')
      },
    }
    const result = await lintCheck({ adapters: [adapter('one'), adapter('two')] }).run({
      dir: '/p',
      runner,
    })
    expect(result).toEqual({ issues: [], changes: [], skipped: 'one, two not installed' })
  })

  test('only selects named adapters', async () => {
    const check = lintCheck({ adapters: [adapter('one'), adapter('two')], only: ['two'] })
    const { runner, calls } = createFakeRunner()
    await check.run({ dir: '/p', runner })
    expect(calls.map((call) => call.command[0])).toEqual(['two', 'two'])
  })

  test('keeps other results when one linter fails, throws when all fail', async () => {
    const { runner } = createFakeRunner((command) =>
      command[0] === 'bad' && command[1] === 'lint'
        ? { exitCode: 2, stderr: 'config error' }
        : { stdout: '1.0.0' },
    )
    const mixed = await lintCheck({ adapters: [adapter('bad'), adapter('good')] }).run({
      dir: '/p',
      runner,
    })
    expect(mixed.version).toBe('bad 1.0.0 (failed: exited with 2: config error), good 1.0.0')
    expect(mixed.issues).toHaveLength(1)

    expect(lintCheck({ adapters: [adapter('bad')] }).run({ dir: '/p', runner })).rejects.toThrow(
      'bad: exited with 2',
    )
  })

  test('is not detected when no linter is configured', async () => {
    expect(await lintCheck({ adapters: [adapter('off', false)] }).detect('/p')).toBe(false)
  })
})
