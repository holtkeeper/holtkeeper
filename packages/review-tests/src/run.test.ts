import { afterEach, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { project } from '../test/project.ts'
import { runTest, tail, testCommand } from './run.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('testCommand', () => {
  test('runs from the nearest package of the test file', async () => {
    const { dir } = await project({
      'packages/cart/package.json': '{"name":"cart"}',
      'packages/cart/src/a.ts': '',
    })
    dirs.push(dir)

    expect(testCommand(dir, 'js', 'vitest', 'packages/cart/src/a.test.ts')).toEqual({
      cwd: 'packages/cart',
      command: ['npx', '--no-install', 'vitest', 'run', 'src/a.test.ts'],
    })
    expect(testCommand(dir, 'js', 'bun:test', 'src/a.test.ts')).toEqual({
      cwd: '.',
      command: ['bun', 'test', './src/a.test.ts'],
    })
  })
})

describe('tail', () => {
  test('keeps the last lines', () => {
    expect(tail('a\nb\nc\n', 2)).toBe('b\nc')
    expect(tail('abcdef', 80, 3)).toBe('…def')
  })
})

describe('runTest', () => {
  const base = { dir: '/repo', cwd: 'pkg', command: ['bun', 'test'], timeoutMs: 1000 }

  test('passes on exit code 0 and runs in cwd with CI set', async () => {
    const { runner, calls } = createFakeRunner(() => ({ stdout: 'ok', stderr: 'warn' }))
    const result = await runTest({ ...base, runner })
    expect(result).toMatchObject({ passed: true, output: 'ok\nwarn' })
    expect(calls[0]?.options).toMatchObject({
      cwd: '/repo/pkg',
      timeoutMs: 1000,
      env: { CI: 'true' },
    })
  })

  test('a process that cannot start fails', async () => {
    const runner = {
      run: async () => {
        throw new Error('not found')
      },
    }
    const result = await runTest({ ...base, runner })
    expect(result).toMatchObject({ passed: false, output: 'could not start `bun test`: not found' })
  })
})
