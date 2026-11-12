import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { analyzeCoverage } from './analyze.ts'
import { frozenInstallCommand, installDependencies } from './install.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'coverage-install-'))
})

afterEach(() => rm(dir, { recursive: true, force: true }))

test('frozen install commands skip lifecycle scripts unless allowed', () => {
  expect(frozenInstallCommand('npm', false)).toEqual([
    'npm',
    'ci',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ])
  expect(frozenInstallCommand('pnpm', true)).toEqual(['pnpm', 'install', '--frozen-lockfile'])
  expect(frozenInstallCommand('yarn-berry', false)).toEqual(['yarn', 'install', '--immutable'])
})

test('installs from the lockfile only when node_modules is missing', async () => {
  const { runner, calls } = createFakeRunner(() => ({ exitCode: 0 }))
  expect(await installDependencies({ dir, runner })).toEqual({
    status: 'skipped',
    reason: 'no package.json',
  })
  await writeFile(join(dir, 'package.json'), '{"packageManager":"pnpm@9.12.0"}')
  expect(await installDependencies({ dir, runner })).toEqual({
    status: 'skipped',
    reason: 'no lockfile',
  })
  await writeFile(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  expect(await installDependencies({ dir, runner })).toEqual({
    status: 'installed',
    command: ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'],
  })
  expect(calls[0]?.options).toMatchObject({ cwd: dir, env: { npm_config_ignore_scripts: 'true' } })
  await mkdir(join(dir, 'node_modules'))
  expect(await installDependencies({ dir, runner })).toEqual({
    status: 'skipped',
    reason: 'node_modules exists',
  })
  expect(calls).toHaveLength(1)
})

test('a failed install is reported with the collection error', async () => {
  await writeFile(join(dir, 'package.json'), '{}')
  await writeFile(join(dir, 'package-lock.json'), '{}')
  const { runner } = createFakeRunner(() => ({ exitCode: 1, stderr: 'npm ERR! code EINTEGRITY' }))
  const lines: string[] = []
  const failing = {
    name: 'vitest --coverage',
    collect: () => Promise.reject(new Error('no report')),
  }
  const run = analyzeCoverage({
    dir,
    runner,
    collectors: [failing],
    log: (line) => lines.push(line),
  })
  expect(run).rejects.toThrow(
    'installing dependencies failed (npm ci --ignore-scripts --no-audit --no-fund): exit 1: npm ERR! code EINTEGRITY\nso no tests could run:\nvitest --coverage: no report',
  )
  await run.catch(() => undefined)
  expect(lines).toEqual([
    'dependencies: npm ci --ignore-scripts --no-audit --no-fund failed\nexit 1: npm ERR! code EINTEGRITY',
  ])
})

test('a registry 404 heads the error, before the missing test runner', async () => {
  await writeFile(join(dir, 'package.json'), '{}')
  await writeFile(join(dir, 'package-lock.json'), '{}')
  const { runner } = createFakeRunner(() => ({
    exitCode: 1,
    stderr: [
      'npm error code E404',
      'npm error 404 Not Found - GET https://registry.example.com/@acme%2fwidget-kit - Not found',
      'npm error 404',
      "npm error 404  '@acme/widget-kit@1.2.3' is not in this registry.",
      'npm error A complete log of this run can be found in: /root/.npm/_logs/debug-0.log',
    ].join('\n'),
  }))
  const missingRunner = {
    name: 'vitest --coverage',
    collect: () =>
      Promise.reject(new Error('npm error npx canceled due to missing packages and no YES option')),
  }
  const error = await analyzeCoverage({ dir, runner, collectors: [missingRunner] }).catch(
    (caught: unknown) => caught,
  )
  const message = error instanceof Error ? error.message : ''
  expect(message.split('\n')[0]).toBe(
    'installing dependencies failed (npm ci --ignore-scripts --no-audit --no-fund): exit 1: npm error code E404',
  )
  expect(message).toContain("'@acme/widget-kit@1.2.3' is not in this registry.")
  expect(message).not.toContain('complete log')
  expect(message.indexOf('E404')).toBeLessThan(message.indexOf('npx canceled'))
})

test('retries an install that failed on the network once', async () => {
  await writeFile(join(dir, 'package.json'), '{}')
  await writeFile(join(dir, 'package-lock.json'), '{}')
  let attempts = 0
  const { runner, calls } = createFakeRunner(() =>
    ++attempts === 1
      ? { exitCode: 1, stderr: 'npm error network socket hang up' }
      : { exitCode: 0 },
  )
  expect(await installDependencies({ dir, runner, retryDelayMs: 0 })).toMatchObject({
    status: 'installed',
  })
  expect(calls).toHaveLength(2)

  const { runner: broken, calls: brokenCalls } = createFakeRunner(() => ({
    exitCode: 1,
    stderr: 'npm error code EINTEGRITY',
  }))
  expect(await installDependencies({ dir, runner: broken, retryDelayMs: 0 })).toMatchObject({
    status: 'failed',
  })
  expect(brokenCalls).toHaveLength(1)
})
