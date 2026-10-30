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
  const { runner } = createFakeRunner(() => ({ exitCode: 1, stderr: 'npm ERR! network' }))
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
    'npm ci --ignore-scripts --no-audit --no-fund failed before: exit 1: npm ERR! network',
  )
  await run.catch(() => undefined)
  expect(lines).toEqual([
    'dependencies: npm ci --ignore-scripts --no-audit --no-fund failed\nexit 1: npm ERR! network',
  ])
})
