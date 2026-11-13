import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { collectorFor } from './collect.ts'

const LCOV = 'SF:src/a.ts\nDA:1,1\nDA:2,0\nend_of_record\n'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quality-collect-'))
})

afterEach(() => rm(dir, { recursive: true, force: true }))

const outOf = (command: string[]) =>
  command.find((part) => part.startsWith('--coverageDirectory='))?.split('=')[1] ?? ''

test('runs package binaries from node_modules/.bin when present', async () => {
  await writeFile(join(dir, 'yarn.lock'), '')
  const { runner, calls } = createFakeRunner(() => ({ exitCode: 1 }))
  await collectorFor('jest', dir)
    .collect({ dir, runner })
    .catch(() => undefined)
  expect(calls[0]?.command.slice(0, 2)).toEqual(['yarn', 'jest'])

  await mkdir(join(dir, 'node_modules', '.bin'), { recursive: true })
  await collectorFor('jest', dir)
    .collect({ dir, runner })
    .catch(() => undefined)
  expect(calls[1]?.command.slice(0, 6)).toEqual([
    'sh',
    '-c',
    'PATH="$PWD/node_modules/.bin:$PATH" exec "$@"',
    'sh',
    'jest',
    '--coverage',
  ])
})

test('finds a report written below the tool root and removes it', async () => {
  const { runner } = createFakeRunner(async (command) => {
    const report = join(dir, 'packages/app', outOf(command))
    await mkdir(report, { recursive: true })
    await writeFile(join(report, 'lcov.info'), LCOV)
    return { exitCode: 1 }
  })
  const report = await collectorFor('jest', dir).collect({ dir, runner })
  expect(report.files.map((file) => file.file)).toEqual(['src/a.ts'])
  const left = await Array.fromAsync(new Bun.Glob('**/coverage-*/**').scan({ cwd: dir, dot: true }))
  expect(left).toEqual([])
})

test('a missing report throws the command error', async () => {
  const { runner } = createFakeRunner(() => ({ exitCode: 1, stderr: 'boom' }))
  expect(collectorFor('jest', dir).collect({ dir, runner })).rejects.toThrow('jest --coverage')
})

const profileOf = (command: string[]) =>
  command.find((part) => part.startsWith('-coverprofile='))?.split('=')[1] ?? ''

const ev = (...list: object[]) => list.map((event) => JSON.stringify(event)).join('\n')

const pass = (pkg: string) =>
  ev(
    {
      Action: 'output',
      Package: pkg,
      Output: `ok  \t${pkg}\t0.01s\tcoverage: 50.0% of statements\n`,
    },
    { Action: 'pass', Package: pkg },
  )

const goRunner = (
  respond: (
    command: string[],
    cwd: string,
  ) => { exitCode?: number; stdout?: string; stderr?: string },
  profile: (command: string[], cwd: string) => string | undefined = () =>
    'mode: set\nexample.com/acme/widgets/calc/calc.go:4.2,5.1 1 0\n',
) =>
  createFakeRunner(async (command, options) => {
    if (command[1] !== 'test') return { exitCode: 1 }
    const text = profile(command, options.cwd)
    if (text !== undefined) await writeFile(join(options.cwd, profileOf(command)), text)
    return respond(command, options.cwd)
  })

const goMod = (path = 'module example.com/acme/widgets\n') => writeFile(join(dir, 'go.mod'), path)

test('go: runs go test -json with a timeout, local toolchain and -mod=mod', async () => {
  await goMod()
  const { runner, calls } = goRunner(() => ({ stdout: pass('example.com/acme/widgets/calc') }))
  await collectorFor('go test', dir).collect({ dir, runner })
  const [run] = calls
  expect(run?.command.slice(0, 4)).toEqual(['go', 'test', '-json', '-timeout=5m'])
  expect(run?.command.at(-1)).toBe('./...')
  expect(run?.options.env).toEqual({ GOTOOLCHAIN: 'local', GOFLAGS: '-mod=mod', GOWORK: 'off' })
  expect(run?.options.cwd).toBe(join(dir, ''))
})

test('go: a run in which no package ran throws with the build output', async () => {
  await goMod()
  const { runner } = goRunner(() => ({
    exitCode: 1,
    stdout: ev(
      {
        ImportPath: 'example.com/acme/widgets/calc [example.com/acme/widgets/calc.test]',
        Action: 'build-output',
        Output: 'calc/calc_test.go:9:2: undefined: Discount\n',
      },
      {
        Action: 'fail',
        Package: 'example.com/acme/widgets/calc',
        FailedBuild: 'example.com/acme/widgets/calc [example.com/acme/widgets/calc.test]',
      },
    ),
  }))
  expect(collectorFor('go test', dir).collect({ dir, runner })).rejects.toThrow(
    'undefined: Discount',
  )
})

test('go: keeps coverage when some packages ran, logs and reports the rest', async () => {
  await goMod()
  const { runner } = goRunner(() => ({
    exitCode: 1,
    stdout: [
      pass('example.com/acme/widgets/calc'),
      ev(
        {
          Action: 'output',
          Package: 'example.com/acme/widgets/price',
          Output: 'FAIL\texample.com/acme/widgets/price\t0.02s\n',
        },
        { Action: 'fail', Package: 'example.com/acme/widgets/price' },
        {
          Action: 'output',
          Package: 'example.com/acme/widgets/cart',
          Output: 'FAIL\texample.com/acme/widgets/cart [setup failed]\n',
        },
        { Action: 'fail', Package: 'example.com/acme/widgets/cart' },
      ),
    ].join('\n'),
  }))
  const lines: string[] = []
  const report = await collectorFor('go test', dir).collect({
    dir,
    runner,
    log: (line) => lines.push(line),
  })
  expect(report.files.map((file) => file.file)).toEqual(['calc/calc.go'])
  expect(report.notRun).toEqual([{ dir: 'cart', reason: 'setup failed' }])
  expect(lines).toEqual([
    'go test: tests of 1 package(s) did not run: example.com/acme/widgets/cart (setup failed)',
    'go test: tests failed in 1 package(s): example.com/acme/widgets/price',
  ])
})

test('go: runs every module without go.work and reports a module that could not run', async () => {
  await mkdir(join(dir, 'api'), { recursive: true })
  await mkdir(join(dir, 'tools/gen'), { recursive: true })
  await writeFile(join(dir, 'api/go.mod'), 'module example.com/acme/api\n')
  await writeFile(join(dir, 'tools/gen/go.mod'), 'module example.com/acme/gen\n')
  const { runner, calls } = goRunner(
    (_, cwd) =>
      cwd.endsWith('api')
        ? { stdout: pass('example.com/acme/api/route') }
        : { exitCode: 1, stderr: 'go: example.org/zz@v1.0.0: reading 410 Gone' },
    (_, cwd) =>
      cwd.endsWith('api')
        ? 'mode: set\nexample.com/acme/api/route/r.go:3.2,4.1 1 1\n'
        : 'mode: set\n',
  )
  const lines: string[] = []
  const report = await collectorFor('go test', dir).collect({
    dir,
    runner,
    log: (line) => lines.push(line),
  })
  expect(
    calls.filter((call) => call.command[1] === 'test').map((call) => call.options.cwd),
  ).toEqual([join(dir, 'api'), join(dir, 'tools/gen')])
  expect(report.files.map((file) => file.file)).toEqual(['api/route/r.go'])
  expect(report.notRun).toEqual([{ dir: 'tools/gen', reason: 'setup failed', recursive: true }])
  expect(lines).toEqual([
    'go test (tools/gen): no tests ran: go: example.org/zz@v1.0.0: reading 410 Gone',
  ])
})

test('go: a go.work runs once at the root over every member', async () => {
  await mkdir(join(dir, 'lib'), { recursive: true })
  await writeFile(join(dir, 'go.work'), 'go 1.22\n\nuse (\n\t.\n\t./lib\n)\n')
  await goMod()
  await writeFile(join(dir, 'lib/go.mod'), 'module example.com/acme/lib\n')
  const { runner, calls } = goRunner(() => ({ stdout: pass('example.com/acme/lib') }))
  await collectorFor('go test', dir).collect({ dir, runner })
  const tests = calls.filter((call) => call.command[1] === 'test')
  expect(tests).toHaveLength(1)
  expect(tests[0]?.command.slice(-2)).toEqual(['./...', './lib/...'])
  expect(tests[0]?.options.env?.GOWORK).toBeUndefined()
  expect(tests[0]?.options.env?.GOFLAGS).toBeUndefined()
  expect(tests[0]?.options.env?.GOTOOLCHAIN).toBe('local')
})

test('go: a failed root module does not cover nested modules that ran on their own', async () => {
  await goMod()
  await mkdir(join(dir, 'tools/gen'), { recursive: true })
  await writeFile(join(dir, 'tools/gen/go.mod'), 'module example.com/acme/gen\n')
  const { runner } = goRunner(
    (_, cwd) =>
      cwd.endsWith('gen')
        ? { stdout: pass('example.com/acme/gen') }
        : { exitCode: 1, stderr: 'go: example.org/zz@v1.0.0: reading 410 Gone' },
    (_, cwd) =>
      cwd.endsWith('gen') ? 'mode: set\nexample.com/acme/gen/g.go:3.2,4.1 1 1\n' : 'mode: set\n',
  )
  const report = await collectorFor('go test', dir).collect({ dir, runner })
  expect(report.notRun).toEqual([
    { dir: '', reason: 'setup failed', recursive: true, except: ['tools/gen'] },
  ])
})

test('go: tags add a second run whose coverage is merged, and untagged tag-only tests are logged', async () => {
  await goMod()
  await mkdir(join(dir, 'calc'), { recursive: true })
  await writeFile(join(dir, 'calc/db_test.go'), '//go:build integration\n\npackage calc\n')
  const plain = goRunner(() => ({ stdout: pass('example.com/acme/widgets/calc') }))
  const lines: string[] = []
  await collectorFor('go test', dir).collect({
    dir,
    runner: plain.runner,
    log: (l) => lines.push(l),
  })
  expect(lines[0]).toStartWith('go test: 1 test file(s) need build tags this run does not set')
  expect(lines[0]).toContain('integration (1)')

  const tagged = goRunner(
    () => ({ stdout: pass('example.com/acme/widgets/calc') }),
    (command) =>
      command.includes('-tags=integration')
        ? 'mode: set\nexample.com/acme/widgets/calc/calc.go:7.2,8.1 1 1\n'
        : 'mode: set\nexample.com/acme/widgets/calc/calc.go:4.2,5.1 1 0\n',
  )
  const tagLines: string[] = []
  const report = await collectorFor('go test', dir, {
    go: { tags: ['integration'], testTimeout: '2m' },
  }).collect({
    dir,
    runner: tagged.runner,
    log: (l) => tagLines.push(l),
  })
  const tests = tagged.calls.filter((call) => call.command[1] === 'test')
  expect(tests.map((call) => call.command.includes('-tags=integration'))).toEqual([false, true])
  expect(tests[0]?.command).toContain('-timeout=2m')
  expect(report.summary.lines).toEqual({ covered: 1, total: 2 })
  expect(tagLines).toEqual([])
})
