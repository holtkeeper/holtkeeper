import { beforeEach, expect, test } from 'bun:test'

import type { BranchesOverview } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { type BranchCandidate, type BranchesData, branchesMetrics } from '@holtkeeper/branches'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { AnalysisQuery, AnalysisStore, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { builtinAnalyses } from '../src/analyses.ts'
import { createApp } from '../src/app.ts'
import { BRANCHES_PREVIOUS_SCAN } from '../src/branches.ts'

const config = parseConfig({
  forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => ({}) as never } },
  groups: {
    shapes: { forge: 'work', include: ['shapes/*'] },
    colors: { forge: 'work', include: ['colors/*'] },
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

const now = new Date('2026-11-10T12:00:00.000Z')
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString()

const candidate = (
  name: string,
  reason: BranchCandidate['reason'],
  ageDays: number,
  author?: string,
): BranchCandidate => ({
  name,
  reason,
  committedAt: daysAgo(ageDays),
  ageDays,
  ...(author ? { author } : {}),
})

const data = (candidates: BranchCandidate[], total = 10): BranchesData => ({
  defaultBranch: 'main',
  staleDays: 90,
  checkedAt: now.toISOString(),
  total,
  open: 2,
  candidates,
})

let store: Store
let app: ReturnType<typeof createApp>
let headReads: AnalysisQuery[]
let dataReads: string[]

const counting = (analyses: AnalysisStore): AnalysisStore => ({
  ...analyses,
  heads: async (query) => {
    headReads.push(query ?? {})
    return analyses.heads(query)
  },
  get: async (id) => {
    dataReads.push(`get:${id}`)
    return analyses.get(id)
  },
  list: async (query) => {
    dataReads.push('list')
    return analyses.list(query)
  },
  latest: async (query) => {
    dataReads.push('latest')
    return analyses.latest(query)
  },
})

beforeEach(() => {
  store = memoryStore()
  headReads = []
  dataReads = []
  const vault = aesVault('v'.repeat(32))
  app = createApp({
    config,
    auth,
    store: { ...store, analyses: counting(store.analyses) },
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: builtinAnalyses,
    now: () => now,
  })
})

const add = (path: string, createdAt: string, value: BranchesData, ref?: string) =>
  store.analyses.add({
    repo: { forge: 'work', path },
    kind: 'branches',
    ...(ref ? { ref } : {}),
    createdAt,
    data: value,
    metrics: branchesMetrics(value),
  })

const overview = async (headers = asAdmin) => {
  const response = await app.request('/api/branches', { headers })
  expect(response.status).toBe(200)
  return (await response.json()) as BranchesOverview
}

test('rows from metrics with the change against the previous run and authors', async () => {
  await add('shapes/circle', daysAgo(14), data([candidate('feat/a', 'merged', 30, 'ana')], 8))
  await add('shapes/circle', daysAgo(8), data([candidate('wip/x', 'stale', 5, 'lev')]), 'feature')
  const newest = await add(
    'shapes/circle',
    daysAgo(7),
    data([
      candidate('feat/a', 'merged', 37, 'ana'),
      candidate('feat/b', 'closed', 12, 'ana'),
      candidate('spike/c', 'stale', 200),
    ]),
  )
  await add('colors/red', daysAgo(3), data([], 4))

  const result = await overview()
  expect(result.repos.map((row) => row.repo.path)).toEqual(['shapes/circle', 'colors/red'])
  const [circle, red] = result.repos
  expect(circle).toMatchObject({
    groups: ['shapes'],
    analysisId: newest.id,
    createdAt: daysAgo(7),
    defaultBranch: 'main',
    staleDays: 90,
    total: 10,
    open: 2,
    cleanup: 3,
    merged: 1,
    closed: 1,
    stale: 1,
    oldestDays: 200,
    delta: { total: 2, cleanup: 2, merged: 0, closed: 1, stale: 1 },
    more: 0,
  })
  expect(circle?.authors).toEqual([
    { author: 'ana', cleanup: 2, merged: 1, closed: 1, stale: 0, oldestDays: 37 },
    { author: 'unknown', cleanup: 1, merged: 0, closed: 0, stale: 1, oldestDays: 200 },
  ])
  expect(circle?.branches.map((branch) => branch.name)).toEqual(['spike/c', 'feat/a', 'feat/b'])
  expect(red?.delta).toBeUndefined()
  expect(dataReads).toEqual([])
  expect(
    headReads.filter((query) => query.repo).every((q) => q.limit === BRANCHES_PREVIOUS_SCAN),
  ).toBe(true)
})

test('merge requests and the rest beyond the stored branches', async () => {
  const many = Array.from({ length: 25 }, (_, index) =>
    candidate(`feat/widget-${index}`, 'merged', 10 + index, 'ana'),
  )
  many[24] = {
    ...candidate('feat/widget-24', 'merged', 34, 'ana'),
    mergeRequest: {
      id: 7,
      state: 'merged',
      title: 'Add widget',
      author: 'ana',
      webUrl: 'https://gitlab.test/acme/widgets/-/merge_requests/7',
    },
  }
  await add('shapes/circle', daysAgo(1), data(many, 30))
  const [row] = (await overview()).repos
  expect(row?.branches).toHaveLength(20)
  expect(row?.more).toBe(5)
  expect(row?.branches[0]?.mergeRequest).toEqual({
    iid: 7,
    state: 'merged',
    title: 'Add widget',
    url: 'https://gitlab.test/acme/widgets/-/merge_requests/7',
  })
})

test('a narrow grant sees only the repositories it may read', async () => {
  await add('shapes/circle', daysAgo(2), data([candidate('feat/a', 'merged', 3)]))
  await add('colors/red', daysAgo(2), data([candidate('feat/b', 'merged', 3)]))
  expect((await overview(asShapes)).repos.map((row) => row.repo.path)).toEqual(['shapes/circle'])
  expect((await overview(asAdmin)).repos).toHaveLength(2)
})

const previousReads = () => headReads.filter((query) => query.repo).length

test('answers from the cache until a newer record arrives', async () => {
  await add('shapes/circle', daysAgo(3), data([candidate('feat/a', 'merged', 3)]))
  await add('shapes/circle', daysAgo(2), data([]))
  await overview()
  expect(previousReads()).toBe(1)
  await overview()
  expect(previousReads()).toBe(1)

  await add('shapes/circle', daysAgo(1), data([candidate('feat/c', 'stale', 120)]))
  const [row] = (await overview()).repos
  expect(previousReads()).toBe(2)
  expect(row?.delta).toEqual({ total: 0, cleanup: 1, merged: 0, closed: 0, stale: 1 })
})

test('records stored before authors and branches existed show empty lists', async () => {
  await store.analyses.add({
    repo: { forge: 'work', path: 'shapes/circle' },
    kind: 'branches',
    createdAt: daysAgo(1),
    data: data([candidate('feat/a', 'merged', 3)]),
    metrics: { total: 5, open: 1, cleanup: 1, merged: 1, closed: 0, stale: 0 },
  })
  const [row] = (await overview()).repos
  expect(row).toMatchObject({ cleanup: 1, authors: [], branches: [], more: 1, defaultBranch: '' })
})
