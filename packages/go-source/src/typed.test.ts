import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { type GoTypedSite, goTypedUsages } from './typed.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'go-typed-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const site: GoTypedSite = {
  file: 'main.go',
  line: 7,
  column: 4,
  importPath: 'example.com/acme/shapes/canvas',
  export: 'Canvas',
  member: 'Draw',
  kind: 'call',
}

const output = (sites: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ packages: 2, sites, ...extra })

test('skips without go', async () => {
  const { runner } = createFakeRunner(() => {
    throw new Error('command not found: go')
  })
  const outcome = await goTypedUsages({ dir, runner, runs: [{ dir: '.' }] })
  expect(outcome).toMatchObject({ status: 'skipped', sites: [] })
  expect(outcome.reason).toContain('go is not available')
})

test('skips without runs', async () => {
  const { runner, calls } = createFakeRunner()
  expect(await goTypedUsages({ dir, runner, runs: [] })).toMatchObject({
    status: 'skipped',
    reason: 'no Go module',
  })
  expect(calls).toEqual([])
})

test('runs the helper from a hidden copy in the checkout and removes it', async () => {
  let helperSeen = false
  const { runner, calls } = createFakeRunner((command, options) => {
    if (command[1] !== 'run') return { stdout: 'go version go1.30.0 linux/amd64' }
    helperSeen = existsSync(join(options.cwd, 'main.go')) && existsSync(join(options.cwd, 'go.mod'))
    return { stdout: output([site, { ...site, kind: 'nonsense' }], { errors: ['x.go: oops'] }) }
  })
  const outcome = await goTypedUsages({
    dir,
    runner,
    runs: [
      { dir: '.', gowork: 'go.work', patterns: ['./...', './tools/...'] },
      { dir: 'nested/mod' },
    ],
    maxSites: 10,
    timeoutMs: 60_000,
  })
  expect(helperSeen).toBe(true)
  expect(outcome).toMatchObject({ status: 'used', packages: 4, sites: [site, site] })
  expect(outcome.errors).toEqual(['.: x.go: oops', 'nested/mod: x.go: oops'])
  expect(await readdir(dir)).toEqual([])

  const [version, first, second] = calls
  expect(version?.command).toEqual(['go', 'version'])
  expect(first?.options.cwd.startsWith(join(dir, '.holtkeeper-typedusages-'))).toBe(true)
  expect(first?.options.env).toEqual({ GOTOOLCHAIN: 'local', GOWORK: 'off' })
  expect(first?.command.slice(0, 11)).toEqual([
    'go',
    'run',
    '.',
    '-root',
    '..',
    '-C',
    '..',
    '-gowork',
    '../go.work',
    '-max',
    '10',
  ])
  expect(first?.command.slice(-2)).toEqual(['./...', './tools/...'])
  expect(second?.command.slice(5, 11)).toEqual([
    '-C',
    '../nested/mod',
    '-gowork',
    'off',
    '-max',
    '9',
  ])
  expect(first?.options.timeoutMs).toBeGreaterThan(60_000)
})

test('keeps the runs that succeed and fails when none does', async () => {
  const failing = createFakeRunner((command) => {
    if (command[1] !== 'run') return {}
    return command.includes('../broken')
      ? { exitCode: 1, stderr: 'go: example.com/acme/missing@v1.0.0: reading: 404' }
      : { stdout: output([site]) }
  })
  const partly = await goTypedUsages({
    dir,
    runner: failing.runner,
    runs: [{ dir: 'broken' }, { dir: 'fine' }],
  })
  expect(partly.status).toBe('used')
  expect(partly.sites).toEqual([site])
  expect(partly.errors[0]).toContain('broken: go: example.com/acme/missing')

  const broken = createFakeRunner((command) => (command[1] === 'run' ? { stdout: 'not json' } : {}))
  const none = await goTypedUsages({ dir, runner: broken.runner, runs: [{ dir: '.' }] })
  expect(none.status).toBe('failed')
  expect(none.reason).toContain('.: ')
  expect(await readdir(dir)).toEqual([])
})

test('stops at the site cap', async () => {
  const { runner, calls } = createFakeRunner((command) =>
    command[1] === 'run' ? { stdout: output([site, site], { truncated: true }) } : {},
  )
  const outcome = await goTypedUsages({
    dir,
    runner,
    runs: [{ dir: 'a' }, { dir: 'b' }],
    maxSites: 2,
  })
  expect(outcome).toMatchObject({ status: 'used', truncated: true })
  expect(outcome.sites).toHaveLength(2)
  expect(calls.filter((call) => call.command[1] === 'run')).toHaveLength(1)
})
