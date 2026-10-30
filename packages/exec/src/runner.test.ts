import { describe, expect, test } from 'bun:test'

import { CommandError, localRunner, runChecked } from './runner.ts'
import { createFakeRunner } from './testing.ts'

describe('localRunner', () => {
  test('captures output and exit code', async () => {
    const result = await localRunner.run(['sh', '-c', 'echo out; echo err >&2; exit 3'], {
      cwd: import.meta.dir,
    })
    expect(result).toEqual({ exitCode: 3, stdout: 'out\n', stderr: 'err\n' })
  })

  test('passes environment and working directory', async () => {
    const result = await localRunner.run(['sh', '-c', 'echo "$HK_VALUE $(pwd)"'], {
      cwd: '/',
      env: { HK_VALUE: 'set' },
    })
    expect(result.stdout).toBe('set /\n')
  })

  test('rejects when the binary does not exist', async () => {
    expect(localRunner.run(['holtkeeper-missing-binary'], { cwd: '/' })).rejects.toThrow(
      'command not found: holtkeeper-missing-binary',
    )
  })
})

describe('runChecked', () => {
  test('returns results for accepted exit codes', async () => {
    const { runner } = createFakeRunner(() => ({ exitCode: 1, stdout: 'found' }))
    const result = await runChecked(runner, ['tool'], { cwd: '/' }, [0, 1])
    expect(result.stdout).toBe('found')
  })

  test('throws CommandError with the tail of the output', async () => {
    const { runner } = createFakeRunner(() => ({ exitCode: 2, stderr: 'boom\n' }))
    const error = await runChecked(runner, ['tool', 'arg'], { cwd: '/' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CommandError)
    expect(String(error)).toContain('`tool arg` exited with 2:\nboom')
  })
})
