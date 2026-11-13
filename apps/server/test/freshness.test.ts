import { beforeEach, describe, expect, test } from 'bun:test'

import { parseConfig } from '@holtkeeper/core'
import type { DiffFile, GitForge } from '@holtkeeper/forge'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { z } from 'zod'

import type { JobAnalyzerInfo } from '../src/context.ts'
import {
  freshnessStatus,
  freshnessSummary,
  lastSweepVerdicts,
  noteHead,
  sweepFreshness,
} from '../src/freshness.ts'
import { opsToolset } from '../src/tools/ops.ts'

let store: Store
let clock: Date
let heads: Record<string, string>
let headReads: string[]
let changedFiles: string[]

const sha = (char: string) => char.repeat(40)

const fakeForge = {
  kind: 'gitlab',
  headCommit: async (repo: string) => {
    headReads.push(repo)
    return heads[repo]
  },
  readFile: async (repo: string, file: string) =>
    repo === 'games/a' && file === 'go.mod' ? 'module widget' : undefined,
  compareCommits: async (): Promise<DiffFile[]> =>
    changedFiles.map((path) => ({ oldPath: path, newPath: path }) as DiffFile),
} as unknown as GitForge

const analyzer = (
  kind: string,
  refresh: JobAnalyzerInfo['refresh'],
  extra: Partial<JobAnalyzerInfo> = {},
): JobAnalyzerInfo => ({ kind, scope: 'repo', options: z.object({}), refresh, ...extra })

const analyzers: JobAnalyzerInfo[] = [
  analyzer('shapes', { on: 'change', minInterval: '6h' }),
  analyzer('weekly', { on: 'time', cadence: '7d' }),
]

const config = parseConfig({
  forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => fakeForge } },
  groups: {
    games: { forge: 'work', include: ['games/a'] },
    tools: { forge: 'work', include: ['tools/b'] },
  },
  jobs: {},
})

const deps = (list: JobAnalyzerInfo[] = analyzers) => ({
  config,
  store,
  analyzers: list,
  now: () => clock,
})

const sweep = (list?: JobAnalyzerInfo[]) => sweepFreshness(deps(list), { timezone: 'UTC' })

const advance = (minutes: number) => {
  clock = new Date(clock.getTime() + minutes * 60_000)
}

const record = (path: string, kind: string, createdAt: string, recordSha?: string) =>
  store.analyses.add({
    repo: { forge: 'work', path },
    kind,
    createdAt,
    ...(recordSha && { sha: recordSha }),
    data: {},
  })

const queued = async () =>
  (await store.jobs.list({ status: 'queued' }))
    .map((job) => `${job.analyzer} ${job.repo.path}`)
    .toSorted()

const putSetting = (key: string, value: unknown, scope: Record<string, unknown> = { all: true }) =>
  store.settings.put({
    id: `${key}-${JSON.stringify(scope)}`,
    key,
    scope,
    value,
    secret: false,
    updatedAt: '2026-11-01T00:00:00.000Z',
  })

beforeEach(() => {
  store = memoryStore()
  clock = new Date('2026-11-11T12:00:00.000Z')
  heads = { 'games/a': sha('b'), 'tools/b': sha('c') }
  headReads = []
  changedFiles = []
})

describe('freshness sweeper', () => {
  test('reads heads, waits out the debounce, then queues stale records with a reason', async () => {
    await record('games/a', 'shapes', '2026-11-10T00:00:00.000Z', sha('a'))
    await record('tools/b', 'shapes', '2026-11-10T00:00:00.000Z', sha('c'))
    await record('games/a', 'weekly', '2026-11-10T00:00:00.000Z')
    await record('tools/b', 'weekly', '2026-11-10T00:00:00.000Z')

    const first = await sweep()
    expect(first.heads).toBe(2)
    expect(first.queued).toEqual([])

    advance(31)
    const second = await sweep()
    expect(second.heads).toBe(2)
    expect(
      second.queued.map((job) => [job.analyzer, job.repo.path, job.trigger, job.reason]),
    ).toEqual([['shapes', 'games/a', 'freshness', 'sha aaaaaaa != head bbbbbbb']])
    advance(5)
    const third = await sweep()
    expect(third.heads).toBe(0)
    expect(third.queued).toEqual([])
    expect(headReads).toHaveLength(4)
  })

  test('a push marks the head and minInterval holds back recent records', async () => {
    const kv = store.kv
    if (!kv) throw new Error('no kv')
    await noteHead(kv, { forge: 'work', path: 'games/a' }, sha('d'), clock)
    await record('games/a', 'shapes', '2026-11-11T09:00:00.000Z', sha('a'))
    advance(40)
    const [status] = await freshnessStatus(deps([analyzers[0] as JobAnalyzerInfo]), {
      repo: { forge: 'work', path: 'games/a' },
    })
    expect(status?.decision).toEqual({
      action: 'wait',
      reason: 'minInterval 6h has not passed since the record',
      nextAt: '2026-11-11T15:00:00.000Z',
    })
    expect(status?.wouldRun).toBe(false)
  })

  test('time analyzers run once their cadence elapsed', async () => {
    await record('games/a', 'weekly', '2026-11-01T00:00:00.000Z')
    await record('tools/b', 'weekly', '2026-11-10T00:00:00.000Z')
    const result = await sweep([analyzers[1] as JobAnalyzerInfo])
    expect(result.queued.map((job) => [job.repo.path, job.reason])).toEqual([
      ['games/a', 'cadence 7d elapsed'],
    ])
  })

  test('a queued job is not queued twice', async () => {
    await store.jobs.enqueue({
      analyzer: 'weekly',
      repo: { forge: 'work', path: 'games/a' },
      trigger: 'manual',
      createdAt: clock.toISOString(),
    })
    const result = await sweep([analyzers[1] as JobAnalyzerInfo])
    expect(result.queued.map((job) => job.repo.path)).toEqual(['tools/b'])
  })

  test('the hourly cap spreads the first sweep, oldest records first', async () => {
    await putSetting('freshness.sweep', { maxJobsPerHour: 1 })
    await record('tools/b', 'weekly', '2026-10-01T00:00:00.000Z')
    const result = await sweep([analyzers[1] as JobAnalyzerInfo])
    expect(result.queued.map((job) => job.repo.path)).toEqual(['games/a'])
    expect(result.capped).toBe(1)
    advance(30)
    expect((await sweep([analyzers[1] as JobAnalyzerInfo])).queued).toEqual([])
    advance(31)
    expect(
      (await sweep([analyzers[1] as JobAnalyzerInfo])).queued.map((job) => job.repo.path),
    ).toEqual(['tools/b'])
  })

  test('heavy analyzers wait for the night window', async () => {
    const heavy = [analyzer('heavy', { on: 'time', cadence: '1d', heavy: true })]
    expect((await sweep(heavy)).queued).toEqual([])
    clock = new Date('2026-11-12T02:00:00.000Z')
    expect(await queued()).toEqual([])
    await sweep(heavy)
    expect(await queued()).toEqual(['heavy games/a', 'heavy tools/b'])
  })

  test('a team turns freshness off or slower', async () => {
    await putSetting('freshness', { mode: 'off' }, { groups: ['games'] })
    await putSetting('freshness', { mode: 'slower', factor: 4 }, { groups: ['tools'] })
    await record('tools/b', 'weekly', '2026-11-01T00:00:00.000Z')
    expect((await sweep([analyzers[1] as JobAnalyzerInfo])).queued).toEqual([])
    const [games] = await freshnessStatus(deps([analyzers[1] as JobAnalyzerInfo]), {
      repo: { forge: 'work', path: 'games/a' },
    })
    expect(games?.decision).toEqual({ action: 'skip', reason: 'freshness is off for this team' })
    const [tools] = await freshnessStatus(deps([analyzers[1] as JobAnalyzerInfo]), {
      repo: { forge: 'work', path: 'tools/b' },
    })
    expect(tools?.decision).toMatchObject({
      action: 'fresh',
      reason: 'cadence 7d x4 has not passed',
    })
  })

  test('analyzers not set up or not applying to a repository are skipped', async () => {
    const list = [
      analyzer(
        'setup',
        { on: 'time', cadence: '1d' },
        { options: z.object({ command: z.string() }) },
      ),
      analyzer(
        'go-only',
        { on: 'time', cadence: '1d' },
        { appliesTo: async ({ repo, forge }) => !!(await forge.readFile(repo.path, 'go.mod')) },
      ),
    ]
    await putSetting('analyzers.setup', { command: 'make' }, { groups: ['tools'] })
    await sweep(list)
    expect(await queued()).toEqual(['go-only games/a', 'setup tools/b'])
    const verdicts = await lastSweepVerdicts({ store })
    expect(verdicts.get('work:tools/b\0go-only')).toEqual({ action: 'skip', applies: false })
    expect(verdicts.get('work:games/a\0setup')).toEqual({ action: 'skip' })
    expect(verdicts.get('work:games/a\0go-only')).toEqual({ action: 'run' })
    const status = await freshnessStatus(deps(list), { repo: { forge: 'work', path: 'games/a' } })
    expect(status.find((entry) => entry.analyzer === 'setup')?.decision.reason).toBe(
      'its options are not set up for this repository',
    )
  })

  test('coverage is skipped on a repository with no tests by design, test ids still run', async () => {
    const list = [
      analyzer('coverage', { on: 'time', cadence: '1d' }),
      analyzer('testids', { on: 'time', cadence: '1d' }),
    ]
    await putSetting(
      'repo.tests',
      { expected: false, reason: 'Config only' },
      { groups: ['games'] },
    )
    await sweep(list)
    expect(await queued()).toEqual(['coverage tools/b', 'testids games/a', 'testids tools/b'])
    const status = await freshnessStatus(deps(list), { repo: { forge: 'work', path: 'games/a' } })
    expect(status.find((entry) => entry.analyzer === 'coverage')?.decision).toEqual({
      action: 'skip',
      reason: 'the repository has no tests by design',
    })
  })

  test('analyzers turned off on a repository are skipped with the reason; a narrower entry turns them back on', async () => {
    const list = [
      analyzer('audit', { on: 'time', cadence: '1d' }),
      analyzer('testids', { on: 'time', cadence: '1d' }),
    ]
    await putSetting('repo.analyzers', { off: ['audit'], reason: 'Values only' }, { all: true })
    await putSetting('repo.analyzers', { off: [] }, { repos: ['tools/b'] })
    await sweep(list)
    expect(await queued()).toEqual(['audit tools/b', 'testids games/a', 'testids tools/b'])
    const status = await freshnessStatus(deps(list), { repo: { forge: 'work', path: 'games/a' } })
    expect(status.find((entry) => entry.analyzer === 'audit')?.decision).toEqual({
      action: 'skip',
      reason: 'turned off: Values only',
    })
  })

  test('writing analyzers are skipped on frozen repositories unless they only report', async () => {
    const options = z.object({ dryRun: z.boolean().default(false) })
    const list = [
      analyzer('bumper', { on: 'time', cadence: '1d' }, { exclusive: true, options }),
      analyzer('reporter', { on: 'time', cadence: '1d' }, { exclusive: true, options }),
      analyzer('testids', { on: 'time', cadence: '1d' }),
    ]
    await putSetting('repo.freeze', { reason: 'Shared library' }, { groups: ['games'] })
    await putSetting('analyzers.reporter', { dryRun: true }, { all: true })
    await sweep(list)
    expect(await queued()).toEqual([
      'bumper tools/b',
      'reporter games/a',
      'reporter tools/b',
      'testids games/a',
      'testids tools/b',
    ])
    const status = await freshnessStatus(deps(list), { repo: { forge: 'work', path: 'games/a' } })
    expect(status.find((entry) => entry.analyzer === 'bumper')?.decision).toEqual({
      action: 'skip',
      reason:
        'the repository is read-only for Holtkeeper (repo.freeze) and the analyzer would change it',
    })
  })

  test('an analyzer turned off reads as skipped even while its record is fresh', async () => {
    const list = [analyzer('audit', { on: 'time', cadence: '7d' })]
    await record('games/a', 'audit', '2026-11-11T00:00:00.000Z')
    await putSetting('repo.analyzers', { off: ['audit'] }, { all: true })
    const status = await freshnessStatus(deps(list), { repo: { forge: 'work', path: 'games/a' } })
    expect(status.find((entry) => entry.analyzer === 'audit')?.decision).toEqual({
      action: 'skip',
      reason: 'turned off for this repository',
    })
  })

  test('repositories whose head cannot be read back off instead of taking every slot', async () => {
    delete heads['games/a']
    await sweep()
    expect(headReads.toSorted()).toEqual(['games/a', 'tools/b'])
    advance(31)
    await sweep()
    expect(headReads.filter((repo) => repo === 'games/a')).toHaveLength(1)
    advance(90)
    await sweep()
    expect(headReads.filter((repo) => repo === 'games/a')).toHaveLength(2)
  })

  test('applicability is read from the forge only while the hourly cap has room', async () => {
    await putSetting('freshness.sweep', { maxJobsPerHour: 1 })
    const asked: string[] = []
    const list = [
      analyzer(
        'go-only',
        { on: 'time', cadence: '1d' },
        {
          appliesTo: async ({ repo, forge }) => {
            asked.push(repo.path)
            return !!(await forge.readFile(repo.path, 'go.mod'))
          },
        },
      ),
    ]
    await record('tools/b', 'go-only', '2026-11-01T00:00:00.000Z')
    const first = await sweep(list)
    expect(first.queued.map((job) => job.repo.path)).toEqual(['games/a'])
    expect(first.capped).toBe(1)
    expect(asked).toEqual(['games/a'])
    advance(61)
    const second = await sweep(list)
    expect(second).toMatchObject({ queued: [], capped: 0 })
    expect(asked).toEqual(['games/a', 'tools/b'])
  })

  test('analyzers that call an LLM skip records without a sha and stop at the budget', async () => {
    const guide = [
      analyzer('guide', { on: 'change', minInterval: '7d' }, { needs: { agent: 'optional' } }),
    ]
    await record('games/a', 'guide', '2026-10-01T00:00:00.000Z')
    await record('tools/b', 'guide', '2026-10-01T00:00:00.000Z', sha('a'))
    await sweep(guide)
    advance(31)
    await store.aiUsage.append({
      at: clock.toISOString(),
      repo: { forge: 'work', path: 'tools/b' },
      groups: ['tools'],
      taskKind: 'review',
      actor: 'system',
      provider: 'anthropic',
      model: 'claude-test',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 140,
      costSource: 'reported',
      durationMs: 1,
      turns: 1,
      outcome: 'ok',
    })
    expect((await sweep(guide)).queued).toEqual([])
    const status = await freshnessStatus(deps(guide), { repo: { forge: 'work', path: 'tools/b' } })
    expect(status[0]?.decision.reason).toBe(
      'automatic AI work reached the weekly budget minus its reserve',
    )
    const games = await freshnessStatus(deps(guide), { repo: { forge: 'work', path: 'games/a' } })
    expect(games[0]?.decision.action).toBe('skip')
  })

  test('only changes to the paths an analyzer reads make it stale', async () => {
    const deps2 = [analyzer('locks', { on: 'change', minInterval: '1h', paths: ['**/bun.lock'] })]
    await record('games/a', 'locks', '2026-11-10T00:00:00.000Z', sha('a'))
    await record('tools/b', 'locks', '2026-11-10T00:00:00.000Z', sha('c'))
    changedFiles = ['src/widget.ts']
    await sweep(deps2)
    advance(31)
    expect((await sweep(deps2)).queued).toEqual([])
    heads['games/a'] = sha('e')
    changedFiles = ['apps/web/bun.lock']
    advance(31)
    await sweep(deps2)
    advance(31)
    expect((await sweep(deps2)).queued.map((job) => job.repo.path)).toEqual(['games/a'])
  })

  test('group analyzers run per group on their cadence', async () => {
    const fleet = [analyzer('fleet', { on: 'time', cadence: '1d' }, { scope: 'group' })]
    await record('games', 'fleet', '2026-11-11T00:00:00.000Z')
    const result = await sweep(fleet)
    expect(result.queued.map((job) => [job.repo.path, job.group])).toEqual([['tools', 'tools']])
  })

  test('subgroups get group analyses of their own', async () => {
    const nested = parseConfig({
      forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => fakeForge } },
      groups: {
        shapes: { forge: 'work', include: ['shapes/*'] },
        'shapes.round': { forge: 'work', include: ['shapes/circle'] },
      },
      jobs: {},
    })
    const fleet = [analyzer('fleet', { on: 'time', cadence: '1d' }, { scope: 'group' })]
    const result = await sweepFreshness(
      { config: nested, store, analyzers: fleet, now: () => clock },
      { timezone: 'UTC' },
    )
    expect(result.queued.map((job) => `${job.repo.path} ${job.group}`).toSorted()).toEqual([
      'shapes shapes',
      'shapes.round shapes.round',
    ])
  })

  test('the last sweep is summed per team for the readable targets', async () => {
    const empty = await freshnessSummary(deps(), () => true)
    expect(empty).toEqual({ sweepMinutes: 5, teams: [] })
    await record('tools/b', 'weekly', '2026-11-10T00:00:00.000Z')
    await sweep([analyzers[1] as JobAnalyzerInfo])
    const summary = await freshnessSummary(deps(), (target) => target.repo.path !== 'tools/b')
    expect(summary.at).toBe(clock.toISOString())
    expect(summary.nextAt).toBe('2026-11-11T12:05:00.000Z')
    expect(summary.teams).toEqual([
      { analyzers: [{ analyzer: 'weekly', stale: 1, waiting: 0, fresh: 0, skipped: 0 }] },
      {
        group: 'games',
        analyzers: [{ analyzer: 'weekly', stale: 1, waiting: 0, fresh: 0, skipped: 0 }],
      },
    ])
    const all = await freshnessSummary(deps(), () => true)
    expect(all.teams.find((team) => team.group === 'tools')?.analyzers).toEqual([
      { analyzer: 'weekly', stale: 0, waiting: 0, fresh: 1, skipped: 0 },
    ])
  })

  test('analysis_status reports per analyzer for readable repositories only', async () => {
    await record('games/a', 'weekly', '2026-11-01T00:00:00.000Z', sha('a'))
    const tools = opsToolset({
      repoOf: (value) =>
        value === 'work:games/a' ? { forge: 'work', path: 'games/a' } : undefined,
      jobs: async () => [],
      job: async () => undefined,
      log: async () => ({ total: 0, offset: 0, lines: [], complete: false, steps: [] }),
      why: async () => ({ origin: '', mode: 'host' }),
      stats: async () => {
        throw new Error('not used')
      },
      freshness: (repo) => freshnessStatus(deps(), { repo }, { timezone: 'UTC' }),
    }).tools
    const call = async (repo: string) => {
      const tool = tools.find((candidate) => candidate.name === 'analysis_status')
      if (!tool) throw new Error('analysis_status missing')
      return tool.run({ repo }, { dir: '.', signal: new AbortController().signal })
    }
    const text = await call('work:games/a')
    expect(text).toContain('weekly: stale, due (cadence 7d elapsed)')
    expect(text).toContain('record sha aaaaaaa')
    expect(text).toContain('would run now: yes')
    expect(text).toContain(
      'shapes: stale or due, waiting (the default-branch head is not known yet)',
    )
    expect(await call('work:tools/b').catch((error: Error) => error.message)).toContain(
      'No readable',
    )
  })
})
