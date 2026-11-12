import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { createCommandVerifier, detectChecks, tail, withoutTests } from './checks.ts'

const dirs: string[] = []
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))))

async function project(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'propagate-checks-'))
  dirs.push(dir)
  for (const [file, content] of Object.entries(files)) await writeFile(join(dir, file), content)
  return dir
}

describe('detectChecks', () => {
  test('uses package.json scripts with the detected manager', async () => {
    const dir = await project({
      'package.json': JSON.stringify({
        scripts: { 'type-check': 'tsc', lint: 'oxlint', test: 'vitest' },
      }),
      'pnpm-lock.yaml': '',
    })
    expect(await detectChecks(dir, { checks: { lint: false, build: 'make' }, go: true })).toEqual([
      {
        name: 'install',
        command: 'pnpm install --ignore-scripts',
        env: {
          COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
          YARN_ENABLE_SCRIPTS: 'false',
          npm_config_ignore_scripts: 'true',
        },
      },
      { name: 'typecheck', command: 'pnpm run type-check' },
      { name: 'test', command: 'pnpm run test' },
      { name: 'build', command: 'make' },
      { name: 'go', command: 'go build ./... && go test ./...', env: { GOTOOLCHAIN: 'local' } },
    ])
  })

  test('no install without other checks; scripts allowed on request', async () => {
    expect(await detectChecks(await project({ 'package.json': '{}' }))).toEqual([])
    const dir = await project({
      'package.json': JSON.stringify({ scripts: { build: 'x' } }),
      'bun.lock': '',
    })
    const [install] = await detectChecks(dir, { allowInstallScripts: true })
    expect(install?.command).toBe('bun install')
  })
  test('a repository with no tests by design runs no test script and only builds Go', async () => {
    const dir = await project({
      'package.json': JSON.stringify({ scripts: { lint: 'oxlint', test: 'vitest' } }),
      'bun.lock': '',
    })
    const checks = await detectChecks(dir, { checks: withoutTests(), go: true })
    expect(checks.map((check) => [check.name, check.command])).toEqual([
      ['install', 'bun install --ignore-scripts'],
      ['lint', 'bun run lint'],
      ['go', 'go build ./...'],
    ])
    expect(withoutTests({ test: 'make check' })).toEqual({
      test: 'make check',
      go: 'go build ./...',
    })
  })
})

describe('verifier', () => {
  test('runs via sh, keeps the output tail and stops after a failing install', async () => {
    const { runner, calls } = createFakeRunner((command) =>
      command[2] === 'install' ? { exitCode: 1, stderr: 'E404' } : { stdout: 'ok' },
    )
    const results = await createCommandVerifier().verify({
      dir: '/repo',
      checks: [
        { name: 'install', command: 'install' },
        { name: 'test', command: 'test' },
      ],
      runner,
    })
    expect(calls.map((call) => call.command)).toEqual([['sh', '-c', 'install']])
    expect(calls[0]!.options.env).toMatchObject({ CI: '1' })
    expect(results).toMatchObject([{ name: 'install', ok: false, exitCode: 1, output: 'E404' }])
    expect(tail('a\nb\nc\n', 2)).toBe('b\nc')
  })
})
