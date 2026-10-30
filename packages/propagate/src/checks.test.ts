import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { createCommandVerifier, detectChecks, tail } from './checks.ts'
import { fixUntilPassing, noopFixer } from './fix.ts'
import type { CheckResult, FixInput, Verifier } from './types.ts'

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
      attempt: 0,
    })
    expect(calls.map((call) => call.command)).toEqual([['sh', '-c', 'install']])
    expect(calls[0]!.options.env).toMatchObject({ CI: '1' })
    expect(results).toMatchObject([{ name: 'install', ok: false, exitCode: 1, output: 'E404' }])
    expect(tail('a\nb\nc\n', 2)).toBe('b\nc')
  })
})

describe('fixUntilPassing', () => {
  const failing: CheckResult = {
    name: 'test',
    command: 't',
    exitCode: 1,
    ok: false,
    output: 'x',
    durationMs: 1,
    attempt: 0,
  }

  test('repeats until checks pass, passing generic context and instructions', async () => {
    const inputs: FixInput[] = []
    let runs = 0
    const verifier: Verifier = {
      verify: async ({ attempt }) => [
        { ...failing, ok: ++runs >= 2, exitCode: runs >= 2 ? 0 : 1, attempt },
      ],
    }
    const after: number[] = []
    const { runner } = createFakeRunner(() => ({ exitCode: 128 }))
    const result = await fixUntilPassing({
      dir: '/repo',
      runner,
      verifier,
      fixer: {
        fix: async (input) => {
          inputs.push(input)
          return { summary: `try ${input.attempt}`, changes: [], remainingProblems: [] }
        },
      },
      specs: [
        { name: 'install', command: 'i' },
        { name: 'test', command: 't' },
      ],
      checks: [failing],
      context: [{ title: 'Source diff', text: '+a' }],
      instructions: 'Port the change.',
      afterAttempt: async (attempt) => void after.push(attempt),
    })
    expect(result).toMatchObject({ attempts: 2, report: { summary: 'try 2' }, touched: [] })
    expect(result.checks[0]!.ok).toBe(true)
    expect(after).toEqual([1, 2])
    expect(inputs[0]).toMatchObject({
      attempt: 1,
      instructions: 'Port the change.',
      context: [{ title: 'Source diff' }],
    })
  })

  test('stops when the fixer gives up or install failed', async () => {
    const { runner } = createFakeRunner()
    const verifier: Verifier = { verify: async () => [] }
    const base = { dir: '/repo', runner, verifier, specs: [] }
    expect((await fixUntilPassing({ ...base, fixer: noopFixer, checks: [failing] })).attempts).toBe(
      0,
    )
    const fixer = { fix: async () => ({ summary: '', changes: [], remainingProblems: [] }) }
    const installFailed = await fixUntilPassing({
      ...base,
      fixer,
      checks: [{ ...failing, name: 'install' }],
    })
    expect(installFailed.attempts).toBe(0)
  })
})
