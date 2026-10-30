import { describe, expect, test } from 'bun:test'

import type { AnyAnalyzer } from '@holtkeeper/analyzer'
import { parseConfig } from '@holtkeeper/core'
import type { CommandRunner } from '@holtkeeper/exec'
import type { ManagedRunner } from '@holtkeeper/exec-container'
import { createFakeRunner } from '@holtkeeper/exec/testing'
import type { GitForge } from '@holtkeeper/forge'
import type { Job } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { z } from 'zod'

import { createContextFactory } from './context.ts'
import {
  type RunnerSpec,
  createRunner,
  defaultWorkerImage,
  runnerFactory,
  startOnFirstRun,
} from './execution.ts'

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )

const forge = {
  getRepository: async (path: string) => ({
    path,
    name: path,
    defaultBranch: 'main',
    webUrl: '',
    cloneUrl: `https://forge.test/${path}.git`,
    archived: false,
  }),
  async *listRepositories() {},
} as unknown as GitForge

const configWith = (execution?: object) =>
  parseConfig({
    forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => forge } },
    groups: { games: { forge: 'work', include: ['games/*'] } },
    jobs: execution ? { execution } : {},
  })

const analyzer = (needs: AnyAnalyzer['needs'], scope: 'repo' | 'group' = 'repo'): AnyAnalyzer => ({
  kind: 'x',
  analysis: { kind: 'x' } as AnyAnalyzer['analysis'],
  scope,
  needs,
  options: z.object({}),
  run: async () => ({ data: {} }),
})

const job: Job = {
  id: 'j1',
  analyzer: 'x',
  repo: { forge: 'work', path: 'games/a' },
  options: {},
  trigger: 'manual',
  status: 'running',
  attempts: 1,
  maxAttempts: 3,
  runAfter: 'now',
  createdAt: 'now',
  log: [],
}

const detected = {
  tools: [
    { name: 'node', version: '20', source: '.nvmrc' },
    { name: 'pnpm', version: '9.12.0', source: 'package.json' },
  ],
  notes: ['apps/x/.nvmrc asks for node 18; using 20 from .nvmrc'],
}

function harness(execution?: object, options: { failStart?: boolean } = {}) {
  const events: string[] = []
  const specs: RunnerSpec[] = []
  const lines: string[] = []
  const host = createFakeRunner()
  let next = 0
  const contextFor = createContextFactory({
    config: configWith(execution),
    store: memoryStore(),
    cacheDir: '/cache',
    runner: host.runner,
    checkout: async ({ cloneUrl, ref }) => {
      const dir = `/co/${next++}`
      events.push(`checkout ${cloneUrl} ${dir}`)
      return {
        dir,
        sha: 'abc',
        ref: ref ?? 'main',
        cleanup: async () => void events.push(`rm ${dir}`),
      }
    },
    detectToolchain: async (dir) => {
      events.push(`detect ${dir}`)
      return detected
    },
    toolchainFor: (repo) =>
      repo.path === 'games/a' ? { tools: { node: '22' }, env: { CI: '1' } } : undefined,
    createRunner: (spec): ManagedRunner => {
      specs.push(spec)
      return {
        async start() {
          events.push(`start ${spec.dir}`)
          if (options.failStart) throw new Error('no image')
        },
        async run() {
          events.push(`run ${spec.dir}`)
          return { exitCode: 0, stdout: spec.dir, stderr: '' }
        },
        async stop() {
          events.push(`stop ${spec.dir}`)
        },
      }
    },
  })
  const io = {
    signal: new AbortController().signal,
    log: (line: string) => void lines.push(line),
    options: {},
  }
  return { contextFor, events, specs, lines, host, io }
}

describe('host mode', () => {
  test('is the default and keeps the host runner everywhere', async () => {
    for (const execution of [undefined, { mode: 'host' }]) {
      const { contextFor, events, specs, host, io } = harness(execution)
      const prepared = await contextFor(job, analyzer({ checkout: true }), io)
      expect(prepared.context.runner).toBe(host.runner)
      const extra = await prepared.context.checkout?.({ forge: 'work', path: 'games/b' })
      expect(extra?.runner).toBe(host.runner)
      await prepared.cleanup()
      expect(specs).toEqual([])
      expect(events.filter((event) => event.startsWith('detect'))).toEqual([])
    }
  })
})

describe('container mode', () => {
  const execution = { mode: 'container', image: 'registry.test/worker:1', network: 'none' }

  test('starts a runner for the checkout before the analyzer and stops it before removing it', async () => {
    const { contextFor, events, specs, lines, io } = harness(execution)
    const prepared = await contextFor(job, analyzer({ checkout: true }), io)
    expect(await prepared.context.runner.run(['node', '-v'], { cwd: '/co/0' })).toMatchObject({
      stdout: '/co/0',
    })
    await prepared.cleanup()
    expect(events).toEqual([
      'checkout https://forge.test/games/a.git /co/0',
      'detect /co/0',
      'start /co/0',
      'run /co/0',
      'stop /co/0',
      'rm /co/0',
    ])
    expect(specs[0]).toMatchObject({
      mode: 'container',
      dir: '/co/0',
      extraMounts: [],
      execution: { mode: 'container', image: 'registry.test/worker:1', network: 'none' },
      toolchain: {
        tools: [
          { name: 'node', version: '22', source: 'setting' },
          { name: 'pnpm', version: '9.12.0', source: 'package.json' },
        ],
        env: { CI: '1' },
      },
    })
    expect(lines).toEqual([
      'toolchain (container): node@22 pnpm@9.12.0',
      'toolchain: apps/x/.nvmrc asks for node 18; using 20 from .nvmrc',
    ])
  })

  test('mounts required extra checkouts read-only into the job runner', async () => {
    const { contextFor, specs, io } = harness(execution)
    const prepared = await contextFor(
      job,
      {
        ...analyzer({ checkout: true }),
        requiredCheckouts: () => [{ repo: 'work:platform/config' }],
      },
      io,
    )
    expect(specs).toHaveLength(1)
    expect(specs[0]?.extraMounts).toEqual([
      { hostDir: '/co/1', containerDir: '/checkouts/0', readOnly: true },
    ])
    await prepared.cleanup()
  })

  test('a failing start cleans up the checkout and fails the context', async () => {
    const { contextFor, events, io } = harness(execution, { failStart: true })
    expect(await failure(contextFor(job, analyzer({ checkout: true }), io))).toContain('no image')
    expect(events.slice(-2)).toEqual(['stop /co/0', 'rm /co/0'])
  })

  test('on-demand checkouts get their own runner, started on first use', async () => {
    const { contextFor, events, specs, io } = harness(execution)
    const group = { ...job, repo: { forge: 'work', path: 'games' }, group: 'games' }
    const prepared = await contextFor(group, analyzer({}, 'group'), io)
    const a = await prepared.context.checkout?.({ forge: 'work', path: 'games/a' })
    const b = await prepared.context.checkout?.({ forge: 'work', path: 'games/b' })
    expect(specs.map((spec) => spec.toolchain.tools[0]?.version)).toEqual(['22', '20'])
    expect(events.filter((event) => event.startsWith('start'))).toEqual([])
    await a?.runner?.run(['ls'], { cwd: a.dir })
    await a?.runner?.run(['ls'], { cwd: a.dir })
    expect(events.filter((event) => event.startsWith('start'))).toEqual(['start /co/0'])
    await b?.cleanup()
    expect(events.slice(-1)).toEqual(['rm /co/1'])
    await prepared.cleanup()
    expect(events.slice(-2)).toEqual(['stop /co/0', 'rm /co/0'])
  })

  test('analyzers without a checkout keep the host runner', async () => {
    const { contextFor, host, specs, io } = harness(execution)
    const prepared = await contextFor(job, analyzer({}), io)
    expect(prepared.context.runner).toBe(host.runner)
    expect(specs).toEqual([])
  })

  test('an aborted signal releases what was prepared', async () => {
    const { contextFor, events, io } = harness(execution)
    const controller = new AbortController()
    controller.abort(new Error('canceled'))
    expect(
      await failure(
        contextFor(job, analyzer({ checkout: true }), { ...io, signal: controller.signal }),
      ),
    ).toContain('canceled')
    expect(events.slice(-2)).toEqual(['stop /co/0', 'rm /co/0'])
  })
})

describe('createRunner', () => {
  const host: CommandRunner = createFakeRunner().runner
  const spec = (overrides: Partial<RunnerSpec>): RunnerSpec => ({
    mode: 'container',
    execution: { mode: 'container' },
    toolchain: { tools: [], notes: [], env: {} },
    dir: '/co/0',
    extraMounts: [],
    hostRunner: host,
    log: () => {},
    ...overrides,
  })

  test('container mode uses the setting image, then the config image, then the default', async () => {
    const recorded = createFakeRunner((command) =>
      command.includes('--detach') ? { stdout: 'id' } : undefined,
    )
    const image = async (overrides: Partial<RunnerSpec>) => {
      const runner = createRunner(spec({ hostRunner: recorded.runner, ...overrides }))
      await runner.start()
      const command = recorded.calls.at(-1)?.command ?? []
      return { image: command.at(-3), network: command[command.indexOf('--network') + 1] }
    }
    expect(await image({})).toEqual({ image: defaultWorkerImage, network: 'none' })
    expect(
      await image({
        execution: { mode: 'container', image: 'cfg:1', network: 'full', engine: 'podman' },
      }),
    ).toEqual({ image: 'cfg:1', network: 'bridge' })
    expect(recorded.calls.at(-1)?.command[0]).toBe('podman')
    expect(
      await image({
        execution: { mode: 'container', image: 'cfg:1' },
        toolchain: { tools: [], notes: [], env: {}, image: 'set:2', network: 'full' },
      }),
    ).toEqual({ image: 'set:2', network: 'bridge' })
  })

  test('mise mode prefixes commands on the host', async () => {
    const recorded = createFakeRunner()
    const runner = createRunner(
      spec({
        mode: 'mise',
        hostRunner: recorded.runner,
        toolchain: {
          tools: [{ name: 'go', version: '1.23', source: 'go.mod' }],
          notes: [],
          env: {},
        },
      }),
    )
    await runner.run(['go', 'version'], { cwd: '/co/0' })
    expect(recorded.calls[0]?.command).toEqual(['mise', 'exec', 'go@1.23', '--', 'go', 'version'])
    expect(recorded.calls[0]?.options.env).toMatchObject({ MISE_IGNORED_CONFIG_PATHS: '/co/0' })
  })
})

test('runnerFactory is off in host mode', () => {
  const host = createFakeRunner().runner
  expect(runnerFactory({ execution: undefined, hostRunner: host })).toBeUndefined()
  expect(runnerFactory({ execution: { mode: 'host' }, hostRunner: host })).toBeUndefined()
  expect(runnerFactory({ execution: { mode: 'mise' }, hostRunner: host })).toBeFunction()
})

test('startOnFirstRun shares one start and skips stop when never started', async () => {
  const events: string[] = []
  const inner: ManagedRunner = {
    start: async () => void events.push('start'),
    run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    stop: async () => void events.push('stop'),
  }
  const unused = startOnFirstRun(inner)
  await unused.stop()
  expect(events).toEqual([])
  const used = startOnFirstRun(inner)
  await Promise.all([used.run(['a'], { cwd: '/' }), used.run(['b'], { cwd: '/' })])
  await used.stop()
  expect(events).toEqual(['start', 'stop'])
})
