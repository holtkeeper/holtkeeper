import { beforeEach, describe, expect, test } from 'bun:test'

import { recordMetrics } from '@holtkeeper/analyzer'
import type { BundlesOverview, BundleTargetsView } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { type BundleData, type BundleTarget, bundleAnalysis } from '@holtkeeper/bundles'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { LINE_SCAN } from '../src/analyses.ts'
import { createApp } from '../src/app.ts'
import { OVERVIEW_RECORDS } from '../src/bundles.ts'

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

const build = (gzip: number): BundleData => ({
  assets: [
    { file: 'main.js', name: 'main.js', kind: 'js', raw: gzip * 3, gzip, brotli: gzip, mapped: 0 },
  ],
  entrypoints: [
    {
      name: 'main',
      initial: ['main.js'],
      lazy: [],
      initialSize: { raw: 0, gzip, brotli: 0 },
      lazySize: { raw: 0, gzip: 0, brotli: 0 },
      packages: [],
      modules: [],
    },
  ],
  packages: [],
  modules: [],
  unmapped: 0,
})

const target = (name: string, gzip?: number, version?: string): BundleTarget => ({
  name,
  source: version ? 'package' : 'build',
  ...(version ? { version } : {}),
  status: gzip === undefined ? 'failed' : 'ok',
  ...(gzip === undefined ? { error: 'build failed' } : { data: build(gzip) }),
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
    analyses: [bundleAnalysis],
    now: () => new Date('2026-10-30T12:00:00.000Z'),
  })
}

const add = async (
  path: string,
  targets: BundleTarget[],
  createdAt: string,
  options?: unknown,
  ref?: string,
) => {
  const record = {
    repo: { forge: 'work', path },
    kind: 'bundle',
    createdAt,
    data: { targets },
    ...(ref ? { ref } : {}),
  }
  const metrics = await recordMetrics(store.analyses, bundleAnalysis, record, options)
  return store.analyses.add({ ...record, ...(metrics ? { metrics } : {}) })
}

const budgets = (value: Record<string, number>, scope: { groups: string[] } | { all: true }) =>
  store.settings.put({
    id: `bundle-${JSON.stringify(scope)}`,
    key: 'analyzers.bundle',
    scope,
    value: { budgets: value },
    secret: false,
    updatedAt: new Date().toISOString(),
  })

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

const overview = async (headers = asAdmin, app = setup()) =>
  (await (await app.request('/api/bundles', { headers })).json()) as BundlesOverview

beforeEach(() => {
  store = memoryStore()
})

describe('bundles overview', () => {
  test('one row per readable repository with each target, its history and delta', async () => {
    await add(
      'shapes/circle',
      [target('web', 1000), target('@acme/widget', 90, '1.0.0')],
      '2026-10-01',
    )
    await add('shapes/circle', [target('web', 1200)], '2026-10-10')
    await add('shapes/circle', [target('web', 1100), target('admin')], '2026-10-20')
    await add('tools/lint', [target('cli', 50)], '2026-10-20')

    const body = await overview()
    expect(body.repos.map((row) => row.repo.path)).toEqual(['shapes/circle', 'tools/lint'])
    const [circle] = body.repos
    expect(circle).toMatchObject({ groups: ['shapes'], records: 3, failed: 1, overBudget: 0 })
    expect(circle?.targets.map((row) => [row.name, row.status, row.gzip])).toEqual([
      ['@acme/widget', 'ok', 90],
      ['admin', 'failed', undefined],
      ['web', 'ok', 1100],
    ])
    const web = circle?.targets.find((row) => row.name === 'web')
    expect(web).toMatchObject({ delta: -100, initial: 1100, overBudget: false })
    expect(web?.series.map((point) => point.gzip)).toEqual([1000, 1200, 1100])
    const widget = circle?.targets.find((row) => row.name === '@acme/widget')
    expect(widget).toMatchObject({ source: 'package', version: '1.0.0' })
    expect(widget?.analysisId).toBe(circle?.targets.at(-1)?.series[0]?.analysisId)

    expect((await overview(asShapes)).repos.map((row) => row.repo.path)).toEqual(['shapes/circle'])
  })

  test('budgets come from the current analyzers.bundle settings of each repository', async () => {
    await add('shapes/circle', [target('web', 1000)], '2026-10-20', { budgets: { web: 5000 } })
    await add('tools/lint', [target('cli', 50)], '2026-10-20')

    const stored = await overview()
    expect(stored.repos[0]?.targets[0]).toMatchObject({ budget: 5000, verdict: 'ok' })

    await budgets({ web: 1050 }, { groups: ['shapes'] })
    await budgets({ '*': 40 }, { all: true })
    const judged = await overview()
    expect(judged.repos.map((row) => row.targets[0]?.verdict)).toEqual(['near', 'over'])
    expect(judged.repos.map((row) => row.overBudget)).toEqual([0, 1])
    expect(judged.repos[1]?.targets[0]).toMatchObject({ budget: 40, overBudget: true })
  })

  test('leaves out repositories whose bundle analyzer is turned off', async () => {
    await add('shapes/circle', [target('web', 1000)], '2026-10-20')
    await add('tools/lint', [target('cli', 50)], '2026-10-20')
    await store.settings.put({
      id: 'off',
      key: 'repo.analyzers',
      scope: { repos: ['work:tools/lint'] },
      value: { off: ['bundle'] },
      secret: false,
      updatedAt: '2026-10-30T10:00:00.000Z',
    })
    expect((await overview()).repos.map((row) => row.repo.path)).toEqual(['shapes/circle'])
  })

  test('reads at most its record limit per repository, as heads, never data', async () => {
    for (let day = 1; day <= OVERVIEW_RECORDS + 5; day++)
      await add(
        'shapes/circle',
        [target('web', 1000 + day)],
        `2026-09-${String(day).padStart(2, '0')}`,
      )
    const calls = spy()
    const [circle] = (await overview()).repos
    expect(circle?.records).toBe(OVERVIEW_RECORDS)
    expect(circle?.targets[0]?.series).toHaveLength(OVERVIEW_RECORDS)
    expect(calls.map((call) => call.method).toSorted()).toEqual(['heads', 'latestHeads'])
    expect(calls.find((call) => call.method === 'heads')?.limit).toBe(LINE_SCAN)
  })

  test('a run on another branch neither becomes the row nor joins the series', async () => {
    await add('shapes/circle', [target('web', 1000)], '2026-10-01')
    await add('shapes/circle', [target('web', 1100)], '2026-10-10')
    await add('shapes/circle', [target('web', 9000)], '2026-10-20', undefined, 'feature/x')
    const [circle] = (await overview()).repos
    expect(circle?.ref).toBeUndefined()
    expect(circle?.records).toBe(2)
    expect(circle?.targets[0]?.gzip).toBe(1100)
    expect(circle?.targets[0]?.series.map((point) => point.gzip)).toEqual([1000, 1100])
  })

  test('a newest record stored without metrics reads its own data once', async () => {
    await store.analyses.add({
      repo: { forge: 'work', path: 'shapes/circle' },
      kind: 'bundle',
      createdAt: '2026-10-20',
      data: { targets: [target('web', 700)] },
    })
    const calls = spy()
    expect((await overview()).repos[0]?.targets[0]?.gzip).toBe(700)
    expect(calls.filter((call) => call.method === 'get' || call.method === 'latest')).toHaveLength(
      1,
    )
  })

  test('answers again from the cache until a record or a budget changes', async () => {
    await add('shapes/circle', [target('web', 1000)], '2026-10-01')
    const calls = spy()
    const app = setup()
    const heads = () => calls.filter((call) => call.method === 'heads').length
    await overview(asAdmin, app)
    const first = heads()
    await overview(asAdmin, app)
    expect(heads()).toBe(first)
    await budgets({ web: 900 }, { all: true })
    expect((await overview(asAdmin, app)).repos[0]?.overBudget).toBe(1)
    expect(heads()).toBeGreaterThan(first)
  })

  test('the target history of one repository still reads its records', async () => {
    await add('shapes/circle', [target('web', 1000)], '2026-10-01')
    const response = await setup().request('/api/bundles/targets?repo=work:shapes/circle', {
      headers: asShapes,
    })
    expect(((await response.json()) as BundleTargetsView).series.map((s) => s.name)).toEqual([
      'web',
    ])
    const forbidden = await setup().request('/api/bundles/targets?repo=work:tools/lint', {
      headers: asShapes,
    })
    expect(forbidden.status).toBe(403)
  })
})
