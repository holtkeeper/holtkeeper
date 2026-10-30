import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { secretsCheck } from './check.ts'

const finding = (extra: Record<string, unknown>) => ({
  RuleID: 'github-pat',
  Description: 'GitHub token',
  StartLine: 1,
  EndLine: 1,
  StartColumn: 5,
  EndColumn: 44,
  File: 'a.txt',
  Match: 'REDACTED',
  Secret: 'REDACTED',
  ...extra,
})

test('runs gitleaks redacted on the tree and the history, dropping duplicates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quality-secrets-'))
  try {
    await mkdir(join(dir, '.git'))
    const { runner, calls } = createFakeRunner((command) => {
      if (command[1] === 'version') return { stdout: '8.30.1\n' }
      if (command[1] === 'dir')
        return {
          exitCode: 2,
          stdout: JSON.stringify([finding({ Fingerprint: 'a.txt:github-pat:1' })]),
        }
      return {
        exitCode: 2,
        stdout: JSON.stringify([
          finding({ Commit: 'abc', Fingerprint: 'abc:a.txt:github-pat:1' }),
          finding({
            File: 'old.txt',
            Commit: 'def',
            Author: 'Ann',
            Date: '2026-01-01',
            Fingerprint: 'def:old.txt:github-pat:1',
          }),
        ]),
      }
    })
    const result = await secretsCheck({ history: true, config: 'ci/gitleaks.toml' }).run({
      dir,
      runner,
    })
    expect(result.version).toBe('gitleaks 8.30.1')
    expect(result.issues?.map((issue) => issue.file)).toEqual(['a.txt', 'old.txt'])
    expect(calls[1]?.command).toEqual([
      'gitleaks',
      'dir',
      '--no-banner',
      '--no-color',
      '--redact',
      '--log-level',
      'error',
      '--exit-code',
      '2',
      '--report-format',
      'json',
      '--report-path',
      '-',
      '--config',
      'ci/gitleaks.toml',
      '.',
    ])
    expect(calls[1]?.options.cwd).toBe(dir)
    expect(calls[2]?.command[1]).toBe('git')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('skips history without a git directory and fails on gitleaks errors', async () => {
  const { runner, calls } = createFakeRunner(() => ({ stdout: '[]' }))
  const result = await secretsCheck({ history: true }).run({ dir: '/nowhere', runner })
  expect(result.issues).toEqual([])
  expect(calls.map((call) => call.command[1])).toEqual(['version', 'dir'])

  const failing = createFakeRunner((command) =>
    command[1] === 'dir' ? { exitCode: 1, stderr: 'bad config' } : {},
  )
  const error: unknown = await secretsCheck()
    .run({ dir: '/nowhere', runner: failing.runner })
    .catch((caught: unknown) => caught)
  expect(String(error)).toContain('bad config')
})

test('detects itself only when the binary exists', async () => {
  expect(await secretsCheck({ binary: '/definitely/not/gitleaks' }).detect('/')).toBe(false)
  expect(await secretsCheck({ binary: 'sh' }).detect('/')).toBe(true)
})
