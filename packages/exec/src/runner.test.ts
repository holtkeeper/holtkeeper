import { describe, expect, test } from 'bun:test'

import { CommandError, localRunner, runChecked } from './runner.ts'
import { createFakeRunner } from './testing.ts'

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

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

  test('an abort stops the command and everything it started', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 200)
    const started = Date.now()
    // The background child inherits the pipes, like a remote helper of git.
    const result = await localRunner.run(['sh', '-c', 'sleep 30 & echo $!; wait'], {
      cwd: '/',
      signal: controller.signal,
    })
    expect(Date.now() - started).toBeLessThan(3000)
    expect(result.exitCode).not.toBe(0)
    const pid = Number(result.stdout.trim())
    await Bun.sleep(50)
    expect(alive(pid)).toBeFalse()
  })

  test('a timeout stops the whole process group', async () => {
    const started = Date.now()
    const result = await localRunner.run(['sh', '-c', 'sleep 30 & echo $!; wait'], {
      cwd: '/',
      timeoutMs: 200,
    })
    expect(Date.now() - started).toBeLessThan(3000)
    await Bun.sleep(50)
    expect(alive(Number(result.stdout.trim()))).toBeFalse()
  })

  test('kills processes that outlive the command and hold its output open', async () => {
    const started = Date.now()
    const result = await localRunner.run(['sh', '-c', 'sleep 30 & echo $!; echo done >&2'], {
      cwd: '/',
    })
    expect(Date.now() - started).toBeLessThan(8000)
    expect(result).toMatchObject({ exitCode: 0, stderr: 'done\n' })
    await Bun.sleep(50)
    expect(alive(Number(result.stdout.trim()))).toBeFalse()
  }, 10_000)

  test('an already aborted signal stops the command at once', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await localRunner.run(['sleep', '30'], { cwd: '/', signal: controller.signal })
    expect(result.exitCode).not.toBe(0)
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
