import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { buildWorkspaces, unbuiltWorkspaces } from './build.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'coverage-build-'))
})

afterEach(() => rm(dir, { recursive: true, force: true }))

async function write(files: Record<string, unknown>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true })
    await writeFile(
      join(dir, path),
      typeof content === 'string' ? content : JSON.stringify(content),
    )
  }
}

const build = { build: 'tsc' }

test('lists unbuilt workspaces after the ones they depend on', async () => {
  await write({
    'package.json': { workspaces: ['src/*'] },
    'src/client/package.json': {
      name: '@x/client',
      main: 'lib/index.js',
      scripts: build,
      dependencies: { '@x/common': '1.0.0' },
    },
    'src/common/package.json': { name: '@x/common', types: 'lib/index.d.ts', scripts: build },
    'src/built/package.json': { name: '@x/built', main: 'index.js', scripts: build },
    'src/built/index.js': '',
    'src/noscript/package.json': { name: '@x/noscript', main: 'lib/index.js' },
  })
  expect(await unbuiltWorkspaces(dir)).toEqual([
    { name: '@x/common', dir: 'src/common', missing: ['lib/index.d.ts'] },
    { name: '@x/client', dir: 'src/client', missing: ['lib/index.js'] },
  ])
})

test('reads pnpm workspaces and the packages form', async () => {
  await write({
    'package.json': { workspaces: { packages: ['libs/*'] } },
    'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
    'libs/a/package.json': { name: 'a', main: 'dist/a.js', scripts: build },
    'apps/b/package.json': { name: 'b', main: 'dist/b.js', scripts: build },
  })
  expect((await unbuiltWorkspaces(dir)).map((ws) => ws.name)).toEqual(['a', 'b'])
})

test('builds each workspace with the package manager and stops at a failure', async () => {
  await write({
    'package.json': { workspaces: ['src/*'] },
    'yarn.lock': '',
    'src/a/package.json': { name: 'a', main: 'lib/a.js', scripts: build },
    'src/b/package.json': { name: 'b', main: 'lib/b.js', scripts: build },
  })
  const { runner, calls } = createFakeRunner((_, options) =>
    options.cwd.endsWith('b') ? { exitCode: 2, stderr: 'TS2307' } : undefined,
  )
  expect(await buildWorkspaces({ dir, runner })).toEqual({
    status: 'failed',
    workspaces: ['a'],
    error: 'b: exit 2: TS2307',
  })
  expect(calls.map((call) => [call.command, call.options.cwd])).toEqual([
    [['yarn', 'run', 'build'], join(dir, 'src/a')],
    [['yarn', 'run', 'build'], join(dir, 'src/b')],
  ])
})

test('skips projects without workspaces', async () => {
  await write({ 'package.json': { main: 'lib/index.js', scripts: build } })
  const { runner, calls } = createFakeRunner()
  expect(await buildWorkspaces({ dir, runner })).toEqual({
    status: 'skipped',
    reason: 'nothing to build',
  })
  expect(calls).toEqual([])
})
