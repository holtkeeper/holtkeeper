import { beforeEach, describe, expect, test } from 'bun:test'

import type { CoverageOverview, RepoCoverageView } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { type CoverageData, coverageAnalysis } from '@holtkeeper/coverage'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

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
  },
})
const asAdmin = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'admin' }
const asShapes = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'shapes' }

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

const add = (path: string, data: unknown, createdAt: string, sha?: string, ref?: string) =>
  store.analyses.add({
    repo: { forge: 'work', path },
    kind: 'coverage',
    createdAt,
    ...(sha ? { sha } : {}),
    ...(ref ? { ref } : {}),
    data,
  })

const get = async (path: string, headers = asAdmin) => {
  const response = await setup().request(path, { headers })
  return { status: response.status, body: await response.json() }
}

beforeEach(() => {
  store = memoryStore()
})

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
      changed: { files: 1, lines: { covered: 60, total: 80 } },
      totals: { files: 2, untested: 1, untestedLines: 20, lines: { covered: 60, total: 100 } },
    })
    expect(circle?.trend).toEqual([
      { at: '2026-10-20T03:00:00.000Z', lines: 40, branches: 50 },
      { at: '2026-10-27T03:00:00.000Z', lines: 60, branches: 50 },
    ])

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

  test('records in an unknown shape are skipped', async () => {
    await add('shapes/square', { files: 'nope' }, '2026-10-27T03:00:00.000Z')
    expect(((await get('/api/coverage')).body as CoverageOverview).repos).toEqual([])
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
    const body = (await get('/api/coverage/repo?repo=work:shapes/circle')).body as RepoCoverageView
    expect(body.card?.analysisId).toBeDefined()
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

  test('answers without a card before the analyzer ran; others are forbidden', async () => {
    const body = (await get('/api/coverage/repo?repo=work:shapes/square')).body as RepoCoverageView
    expect(body).toEqual({
      repo: { forge: 'work', path: 'shapes/square' },
      groups: [],
      worst: [],
      changes: [],
    })
    expect((await get('/api/coverage/repo?repo=work:tools/lint', asShapes)).status).toBe(403)
    expect((await get('/api/coverage/repo', asShapes)).status).toBe(400)
  })
})
