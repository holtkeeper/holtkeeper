import { beforeEach, describe, expect, test } from 'bun:test'

import { recordMetrics } from '@holtkeeper/analyzer'
import type { CoverageOverview, RepoCoverageView } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { type CoverageData, coverageAnalysis } from '@holtkeeper/coverage'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { LINE_SCAN } from '../src/analyses.ts'
import { createApp } from '../src/app.ts'
import { noteHead } from '../src/freshness.ts'

const config = parseConfig({
  forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => ({}) as never } },
  groups: {
    shapes: { forge: 'work', include: ['shapes/circle', 'shapes/square'] },
    tools: { forge: 'work', include: ['tools/lint'] },
  },
})

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['*'] }],
    shapes: [{ scope: { groups: ['shapes'] }, actions: ['analyses:read'] }],
    'shapes-admin': [
      {
        scope: { groups: ['shapes'] },
        actions: ['analyses:read', 'settings:read', 'settings:write'],
      },
    ],
  },
})
const asAdmin = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'admin' }
const asShapes = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'shapes' }
const asShapesAdmin = { 'x-forwarded-user': 'ann', 'x-forwarded-groups': 'shapes-admin' }

const coverage = (covered: number, extra: CoverageData['files'] = []): CoverageData => ({
  tools: ['vitest --coverage'],
  languages: ['js'],
  summary: { lines: { covered: covered, total: 100 }, branches: { covered: 5, total: 10 } },
  files: [
    { file: 'packages/widget/src/a.ts', lines: { covered, total: 80 } },
    { file: 'src/main.ts', lines: { covered: 0, total: 20 }, loaded: false },
    ...extra,
  ],
})

let store: Store

const setup = () => {
  const vault = aesVault('v'.repeat(32))
  return createApp({
    config,
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [coverageAnalysis],
    now: () => new Date('2026-10-30T12:00:00.000Z'),
  })
}

const add = async (path: string, data: unknown, createdAt: string, sha?: string, ref?: string) => {
  const record = {
    repo: { forge: 'work', path },
    kind: 'coverage',
    createdAt,
    ...(sha ? { sha } : {}),
    ...(ref ? { ref } : {}),
    data,
  }
  const metrics = await recordMetrics(store.analyses, coverageAnalysis, record)
  return store.analyses.add({ ...record, ...(metrics ? { metrics } : {}) })
}

/** Store calls of the routes, with the limit each asked for. */
const spy = () => {
  const calls: { method: string; limit?: number }[] = []
  const analyses = store.analyses
  store = {
    ...store,
    analyses: {
      ...analyses,
      list: async (query) => (
        calls.push({ method: 'list', limit: query?.limit }),
        analyses.list(query)
      ),
      heads: async (query) => (
        calls.push({ method: 'heads', limit: query?.limit }),
        analyses.heads(query)
      ),
      latest: async (query) => (calls.push({ method: 'latest' }), analyses.latest(query)),
      latestHeads: async (query) => (
        calls.push({ method: 'latestHeads' }),
        analyses.latestHeads(query)
      ),
      get: async (id) => (calls.push({ method: 'get' }), analyses.get(id)),
    },
  }
  return calls
}

const get = async (path: string, headers = asAdmin) => {
  const response = await setup().request(path, { headers })
  return { status: response.status, body: await response.json() }
}

beforeEach(() => {
  store = memoryStore()
})

const putTests = (
  id: string,
  scope: Record<string, unknown>,
  value: unknown,
  updatedAt = '2026-10-27T00:00:00.000Z',
) => store.settings.put({ id, key: 'repo.tests', scope, value, secret: false, updatedAt })

const testsOf = async (path: string, headers = asAdmin) =>
  ((await get(`/api/coverage/repo?repo=work:${path}`, headers)).body as RepoCoverageView).tests

describe('coverage overview', () => {
  test('one card per readable repository with trend, change and freshness', async () => {
    await add('shapes/circle', coverage(40), '2026-10-20T03:00:00.000Z', 'aaa111')
    await add('shapes/circle', coverage(60), '2026-10-27T03:00:00.000Z', 'bbb222')
    await add('tools/lint', coverage(10), '2026-10-27T03:00:00.000Z')
    await noteHead(store.kv!, { forge: 'work', path: 'shapes/circle' }, 'ccc333', new Date())

    const admin = (await get('/api/coverage')).body as CoverageOverview
    expect(admin.repos.map((card) => card.repo.path)).toEqual(['shapes/circle', 'tools/lint'])
    const [circle] = admin.repos
    expect(circle).toMatchObject({
      groups: ['shapes'],
      sha: 'bbb222',
      head: 'ccc333',
      tools: ['vitest --coverage'],
      change: 20,
      totals: { files: 2, untested: 1, untestedLines: 20, lines: { covered: 60, total: 100 } },
    })
    expect(circle?.trend).toEqual([
      { at: '2026-10-20T03:00:00.000Z', lines: 40, branches: 50 },
      { at: '2026-10-27T03:00:00.000Z', lines: 60, branches: 50 },
    ])
    expect(circle?.changed).toBeUndefined()

    const shapes = (await get('/api/coverage', asShapes)).body as CoverageOverview
    expect(shapes.repos.map((card) => card.repo.path)).toEqual(['shapes/circle'])
  })

  test('runs on other branches stay out of the card', async () => {
    await add('shapes/circle', coverage(40), '2026-10-20T03:00:00.000Z', 'aaa111')
    await add('shapes/circle', coverage(90), '2026-10-28T03:00:00.000Z', 'fff999', 'feature/x')
    await add('tools/lint', coverage(10), '2026-10-20T03:00:00.000Z', 'ddd444', 'main')
    await add('tools/lint', coverage(30), '2026-10-27T03:00:00.000Z', 'eee555', 'main')
    await noteHead(store.kv!, { forge: 'work', path: 'shapes/circle' }, 'aaa111', new Date())

    const [circle, lint] = ((await get('/api/coverage')).body as CoverageOverview).repos
    expect(circle).toMatchObject({ sha: 'aaa111' })
    expect(circle?.head).toBeUndefined()
    expect(circle?.trend).toHaveLength(1)
    expect(lint).toMatchObject({ sha: 'eee555', ref: 'main', change: 20 })
  })

  test('reads heads only, within the line limit, and never record data', async () => {
    for (let day = 10; day < 26; day++)
      await add('shapes/circle', coverage(day), `2026-10-${day}T03:00:00.000Z`)
    await add('tools/lint', coverage(10), '2026-10-27T03:00:00.000Z')
    const calls = spy()
    const [circle] = ((await get('/api/coverage')).body as CoverageOverview).repos
    expect(circle?.trend).toHaveLength(12)
    expect(calls.map((call) => call.method).toSorted()).toEqual(['heads', 'heads', 'latestHeads'])
    expect(
      calls.every((call) => call.method !== 'heads' || (call.limit ?? Infinity) <= LINE_SCAN),
    ).toBe(true)
  })

  test('a newest record stored with older metrics reads its data once for the counts', async () => {
    const created = await add('shapes/circle', coverage(60), '2026-10-27T03:00:00.000Z')
    const { tools: _, totals: __, ...older } = created.metrics as Record<string, unknown>
    store = memoryStore()
    await store.analyses.add({ ...created, metrics: older })
    const calls = spy()
    const [circle] = ((await get('/api/coverage')).body as CoverageOverview).repos
    expect(circle).toMatchObject({ tools: ['vitest --coverage'], totals: { files: 2 } })
    expect(calls.filter((call) => call.method === 'get')).toHaveLength(1)
  })

  test('answers again from the cache until a newer record arrives', async () => {
    await add('shapes/circle', coverage(40), '2026-10-20T03:00:00.000Z')
    const calls = spy()
    const app = setup()
    const read = async () =>
      (
        (await (
          await app.request('/api/coverage', { headers: asAdmin })
        ).json()) as CoverageOverview
      ).repos
    const heads = () => calls.filter((call) => call.method === 'heads').length
    expect((await read())[0]?.totals.lines.covered).toBe(40)
    const first = heads()
    expect(first).toBeGreaterThan(0)
    await read()
    expect(heads()).toBe(first)
    await add('shapes/circle', coverage(50), '2026-10-21T03:00:00.000Z')
    const before = heads()
    expect((await read())[0]?.totals.lines.covered).toBe(50)
    expect(heads()).toBeGreaterThan(before)
  })

  test('records in an unknown shape are skipped', async () => {
    await add('shapes/square', { files: 'nope' }, '2026-10-27T03:00:00.000Z')
    expect(((await get('/api/coverage')).body as CoverageOverview).repos).toEqual([])
  })

  test('each card carries the target of the entry that applies to its repository', async () => {
    await add('shapes/circle', coverage(70), '2026-10-27T03:00:00.000Z')
    await add('tools/lint', coverage(70), '2026-10-27T03:00:00.000Z')
    const entry = {
      key: 'analyzers.coverage',
      secret: false,
      updatedAt: '2026-10-01T00:00:00.000Z',
    }
    await store.settings.put({ ...entry, id: 'all', scope: { all: true }, value: { target: 60 } })
    await store.settings.put({
      ...entry,
      id: 'shapes',
      scope: { groups: ['shapes'] },
      value: { target: '80' },
    })
    await store.settings.put({
      ...entry,
      id: 'lint',
      scope: { repos: ['work:tools/lint'] },
      value: { exclude: ['dist/**'] },
    })

    const { repos } = (await get('/api/coverage')).body as CoverageOverview
    expect(repos.map((card) => [card.repo.path, card.target])).toEqual([
      ['shapes/circle', 80],
      ['tools/lint', undefined],
    ])
  })
})

describe('repository coverage', () => {
  test('breaks coverage down by package and lists worst files and moves', async () => {
    await add('shapes/circle', coverage(40), '2026-10-20T03:00:00.000Z')
    await add(
      'shapes/circle',
      coverage(60, [{ file: 'src/extra.ts', lines: { covered: 10, total: 10 } }]),
      '2026-10-27T03:00:00.000Z',
    )
    const calls = spy()
    const body = (await get('/api/coverage/repo?repo=work:shapes/circle')).body as RepoCoverageView
    expect(calls.filter((call) => call.method === 'get')).toHaveLength(2)
    expect(calls.some((call) => call.method === 'list' || call.method === 'latest')).toBe(false)
    expect(body.card).toMatchObject({
      change: 20,
      changed: { files: 2, lines: { covered: 70, total: 90 } },
      totals: { lines: { covered: 60, total: 100 } },
    })
    expect(body.card?.trend).toHaveLength(2)
    expect(body.groups.map((group) => [group.path, group.lines])).toEqual([
      ['packages/widget', { covered: 60, total: 80 }],
      ['src', { covered: 10, total: 30 }],
    ])
    expect(body.worst.map((file) => file.file)).toEqual(['packages/widget/src/a.ts', 'src/main.ts'])
    expect(body.changes.map((change) => [change.file, change.delta])).toEqual([
      ['src/extra.ts', 100],
      ['packages/widget/src/a.ts', 25],
    ])
  })

  test('names the job behind the newest record', async () => {
    const stored = await add('shapes/circle', coverage(60), '2026-10-27T03:00:00.000Z')
    const job = await store.jobs.enqueue({
      analyzer: 'coverage',
      repo: { forge: 'work', path: 'shapes/circle' },
      options: {},
      trigger: 'manual',
      actor: 'user:jane',
      reason: 'asked from the panel',
      createdAt: '2026-10-27T02:59:00.000Z',
    })
    await store.jobs.claim('worker-1', '2026-10-27T02:59:01.000Z')
    await store.jobs.complete(job.id, { at: '2026-10-27T03:00:00.000Z', analysisId: stored.id })
    const body = (await get('/api/coverage/repo?repo=work:shapes/circle')).body as RepoCoverageView
    expect(body.job).toMatchObject({ id: job.id, status: 'succeeded', trigger: 'manual' })
  })

  test('answers without a card before the analyzer ran; others are forbidden', async () => {
    const body = (await get('/api/coverage/repo?repo=work:shapes/square')).body as RepoCoverageView
    expect(body).toEqual({
      repo: { forge: 'work', path: 'shapes/square' },
      groups: [],
      worst: [],
      changes: [],
      tests: { expected: true, configurable: true },
    })
    expect((await get('/api/coverage/repo?repo=work:tools/lint', asShapes)).status).toBe(403)
    expect((await get('/api/coverage/repo', asShapes)).status).toBe(400)
  })

  test('says how repo.tests applies, and who may change it', async () => {
    await putTests('group', { groups: ['shapes'] }, { expected: false, reason: 'Config only' })
    await putTests('own', { repos: ['work:shapes/square'] }, { expected: false })
    expect(await testsOf('shapes/circle')).toEqual({
      expected: false,
      reason: 'Config only',
      scope: { groups: ['shapes'] },
      configurable: true,
    })
    expect(await testsOf('shapes/square')).toEqual({
      expected: false,
      scope: { repos: ['work:shapes/square'] },
      entryId: 'own',
      inherited: false,
      configurable: true,
    })
    expect(await testsOf('shapes/circle', asShapes)).toEqual({
      expected: false,
      reason: 'Config only',
    })
    expect(await testsOf('tools/lint')).toEqual({ expected: true, configurable: true })
  })

  test('names the own entry even when it turns tests on, and what applies without it', async () => {
    await putTests('own', { repos: ['work:tools/lint'] }, { expected: false })
    expect(await testsOf('tools/lint')).toMatchObject({ entryId: 'own', inherited: true })
    await putTests('lifted', { repos: ['work:shapes/circle'] }, { expected: true })
    await putTests('group', { groups: ['shapes'] }, { expected: false })
    expect(await testsOf('shapes/circle')).toEqual({
      expected: true,
      scope: { repos: ['work:shapes/circle'] },
      entryId: 'lifted',
      inherited: false,
      configurable: true,
    })
  })

  test('a forge-less path entry is not the repository own entry', async () => {
    await putTests('path', { repos: ['shapes/square'] }, { expected: false })
    expect(await testsOf('shapes/square')).toEqual({
      expected: false,
      scope: { repos: ['shapes/square'] },
      configurable: true,
    })
  })

  test('a group admin cannot write a repository-scoped entry, so the toggle is not offered', async () => {
    await putTests('group', { groups: ['shapes'] }, { expected: false })
    expect(await testsOf('shapes/circle', asShapesAdmin)).toEqual({
      expected: false,
      scope: { groups: ['shapes'] },
    })
    expect(await testsOf('shapes/square', asShapesAdmin)).toEqual({
      expected: false,
      scope: { groups: ['shapes'] },
    })
  })
})
