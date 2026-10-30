import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { checkout, mirrorName } from './checkout.ts'

describe('mirrorName', () => {
  test('is stable, readable and ignores credentials in the URL', () => {
    const name = mirrorName('https://gitlab.test/games/app-x.git')
    expect(name).toMatch(/^games-app-x-[0-9a-f]{12}\.git$/)
    expect(mirrorName('https://bot:secret@gitlab.test/games/app-x.git')).toBe(name)
    expect(mirrorName('https://gitlab.test/games/other.git')).not.toBe(name)
  })
})

describe('checkout credentials', () => {
  test('go to remote commands through the environment, never argv', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'holtkeeper-ws-fake-'))
    try {
      const { runner, calls } = createFakeRunner((command) =>
        command.includes('symbolic-ref')
          ? { stdout: 'main\n' }
          : command.includes('rev-parse')
            ? { stdout: 'abc123\n' }
            : undefined,
      )
      const result = await checkout({
        cloneUrl: 'https://gitlab.test/games/a.git',
        credentials: { username: 'oauth2', password: 's3cret' },
        cacheDir,
        workDir: cacheDir,
        runner,
      })
      expect(result).toMatchObject({ sha: 'abc123', ref: 'main' })
      const clone = calls.find((call) => call.command.includes('clone'))
      expect(clone?.command).toContain('--mirror')
      expect(clone?.options.env?.HOLTKEEPER_GIT_PASSWORD).toBe('s3cret')
      expect(calls.some((call) => call.command.join(' ').includes('s3cret'))).toBeFalse()
      const local = calls.filter((call) => !call.command.includes('clone'))
      expect(
        local.every((call) => call.options.env?.HOLTKEEPER_GIT_PASSWORD === undefined),
      ).toBeTrue()
      await result.cleanup()
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })
})
