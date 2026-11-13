import { beforeEach, describe, expect, test } from 'bun:test'

import { analysisMetrics } from '@holtkeeper/analyzer'
import type { AssetsOverview, RepoAssetsView } from '@holtkeeper/api'
import {
  type AssetsData,
  assetsAnalysis,
  assetsSummary,
  defaultAssetsPolicy,
} from '@holtkeeper/assets'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { AnalysisStore, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { LINE_SCAN } from '../src/analyses.ts'
import { createApp } from '../src/app.ts'
import { ASSETS_PAGE_MAX, assetsPage, assetsPolicyFor } from '../src/assets.ts'
import { assetsToolset, pathFacts, storedAssetTools } from '../src/tools/assets.ts'

const config = parseConfig({
  forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => ({}) as never } },
  groups: {
    shapes: { forge: 'work', include: ['shapes/circle'] },
    tools: { forge: 'work', include: ['tools/lint'] },
  },
})

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['*'] }],
    tools: [{ scope: { groups: ['tools'] }, actions: ['analyses:read'] }],
    catalog: [{ scope: { all: true }, actions: ['catalog:read', 'settings:read'] }],
  },
})
const asAdmin = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'admin' }
const asTools = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'tools' }
const asCatalog = { 'x-forwarded-user': 'ann', 'x-forwarded-groups': 'catalog' }

const record = (bytes: number, withPolicy = true): AssetsData => ({
  roots: ['public/**'],
  engines: [],
  convert: 'estimate',
  tools: [],
  assets: [
    { path: 'public/hero.png', kind: 'image', format: 'png', bytes, hash: 'h', origin: 'source' },
    {
      path: 'public/ok.webp',
      kind: 'image',
      format: 'webp',
      bytes: 1000,
      hash: 'o',
      origin: 'source',
    },
  ],
  totals: [{ kind: 'image', count: 2, bytes: bytes + 1000 }],
  budgets: [],
  findings: [],
  suggestions: [
    {
      id: 's',
      rule: 'opaque-png',
      path: 'public/hero.png',
      kind: 'image',
      format: 'png',
      bytes,
      suggested: 'webp',
      how: 'cwebp -q 82',
      expectedBytes: 200_000,
      method: 'estimate',
      saving: bytes - 200_000,
    },
  ],
  duplicates: [],
  ...(withPolicy
    ? {
        policy: defaultAssetsPolicy,
        violations: [
          {
            id: 'max-bytes:public/hero.png',
            rule: 'max-bytes' as const,
            severity: 'error' as const,
            path: 'public/hero.png',
            kind: 'image' as const,
            format: 'png',
            actual: bytes,
            limit: 1_000_000,
            message: '1.2 MB is above the error limit of 1 MB',
          },
        ],
      }
    : {}),
})

let store: Store

const setup = (analyses?: AnalysisStore) => {
  const vault = aesVault('v'.repeat(32))
  return createApp({
    config,
    auth,
    store: analyses ? { ...store, analyses } : store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [assetsAnalysis],
    now: () => new Date('2026-10-30T12:00:00.000Z'),
  })
}

const add = async (path: string, data: AssetsData, createdAt: string, ref?: string) => {
  const repo = { forge: 'work', path }
  const previous = (await store.analyses.latestHeads({ repo, kind: 'assets' }))[0]?.metrics
  return store.analyses.add({
    repo,
    kind: 'assets',
    createdAt,
    data,
    metrics: analysisMetrics(assetsAnalysis, data, previous ? { previous } : {}),
    ...(ref ? { ref } : {}),
  })
}

const lintRecord = (): AssetsData => ({
  roots: ['static/**'],
  engines: [],
  convert: 'estimate',
  tools: [],
  assets: [
    {
      path: 'static/a.jpg',
      kind: 'image',
      format: 'jpeg',
      bytes: 50_000,
      hash: 'a',
      origin: 'source',
    },
    {
      path: 'static/b.jpg',
      kind: 'image',
      format: 'jpeg',
      bytes: 50_000,
      hash: 'a',
      origin: 'source',
    },
    {
      path: 'static/f.ttf',
      kind: 'font',
      format: 'ttf',
      bytes: 300_000,
      hash: 'f',
      origin: 'source',
    },
  ],
  totals: [
    { kind: 'image', count: 2, bytes: 100_000 },
    { kind: 'font', count: 1, bytes: 300_000 },
  ],
  budgets: [],
  findings: [],
  suggestions: [
    {
      id: 'f',
      rule: 'desktop-font',
      path: 'static/f.ttf',
      kind: 'font',
      format: 'ttf',
      bytes: 300_000,
      suggested: 'woff2',
      how: 'woff2_compress',
      expectedBytes: 120_000,
      method: 'estimate',
      saving: 180_000,
    },
  ],
  duplicates: [{ hash: 'a', bytes: 50_000, paths: ['static/a.jpg', 'static/b.jpg'] }],
})

const overview = async (query: string, headers = asAdmin, analyses?: AnalysisStore) => {
  const response = await setup(analyses).request(`/api/assets${query}`, { headers })
  expect(response.status).toBe(200)
  return (await response.json()) as AssetsOverview
}

const paths = (view: AssetsOverview) => view.items.map((item) => item.path)

const spy = (analyses: AnalysisStore) => {
  const calls: { method: string; query: unknown }[] = []
  const spied = new Proxy(analyses, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        calls.push({ method: String(property), query: args[0] })
        return Reflect.apply(value, target, args)
      }
    },
  })
  return { spied, calls }
}

const putPolicy = (scope: object, value: unknown, id = 'p1') =>
  store.settings.put({
    id,
    key: 'assets.policy',
    scope,
    value,
    secret: false,
    updatedAt: '2026-10-30T10:00:00.000Z',
  })

beforeEach(() => {
  store = memoryStore()
})

describe('assets routes', () => {
  test('the repo view has the effective policy, a summary of the newest record and a trend', async () => {
    await add('shapes/circle', record(1_100_000, false), '2026-10-20T03:00:00.000Z')
    await add('shapes/circle', record(1_200_000), '2026-10-29T03:00:00.000Z')
    await putPolicy({ groups: ['shapes'] }, { maxDimension: 4096 })

    const response = await setup().request('/api/assets/repo?repo=work:shapes/circle', {
      headers: asAdmin,
    })
    expect(response.status).toBe(200)
    const view = (await response.json()) as RepoAssetsView
    expect(view.policy.maxDimension).toBe(4096)
    expect(view.policySource).toMatchObject({
      level: 'group',
      entry: { id: 'p1', scope: { groups: ['shapes'] } },
    })
    expect(view.checkedPolicy).toBe(true)
    expect(view.summary).toMatchObject({ files: 2, errors: 1, warnings: 0 })
    expect(view.summary?.rows.map((row) => row.path)).toEqual(['public/hero.png'])
    expect(view.trend.map((point) => [point.totalBytes, point.violations])).toEqual([
      [1_101_000, 0],
      [1_201_000, 1],
    ])
  })

  test('without a record only the default policy is served; other teams are refused', async () => {
    const empty = await setup().request('/api/assets/repo?repo=work:tools/lint', {
      headers: asTools,
    })
    const view = (await empty.json()) as RepoAssetsView
    expect(view).toEqual({
      repo: { forge: 'work', path: 'tools/lint' },
      policy: defaultAssetsPolicy,
      policySource: { level: 'default' },
      trend: [],
    })
    const denied = await setup().request('/api/assets/repo?repo=work:shapes/circle', {
      headers: asTools,
    })
    expect(denied.status).toBe(403)
    const missing = await setup().request('/api/assets/repo', { headers: asAdmin })
    expect(missing.status).toBe(400)
  })

  test('the policy entry is named only to readers of its settings scope', async () => {
    await putPolicy({ groups: ['tools', 'shapes'] }, { maxDimension: 4096 })
    const response = await setup().request('/api/assets/repo?repo=work:tools/lint', {
      headers: asTools,
    })
    const view = (await response.json()) as RepoAssetsView
    expect(view.policy.maxDimension).toBe(4096)
    expect(view.policySource).toEqual({ level: 'group' })
  })
})

describe('fleet assets', () => {
  beforeEach(async () => {
    await add('shapes/circle', record(1_100_000), '2026-10-20T03:00:00.000Z')
    await add('shapes/circle', record(1_200_000), '2026-10-29T03:00:00.000Z')
    await add('tools/lint', lintRecord(), '2026-10-29T04:00:00.000Z')
  })

  test('summarizes every readable repository from metrics and lists their files', async () => {
    const view = await overview('')
    expect(view.repos.map((repo) => [repo.repo.path, repo.groups, repo.files, repo.delta])).toEqual(
      [
        ['shapes/circle', ['shapes'], 2, 100_000],
        ['tools/lint', ['tools'], 3, undefined],
      ],
    )
    expect(view.repos[0]).toMatchObject({ errors: 1, kinds: { image: 1_201_000 } })
    expect(view.items.map((item) => [item.repo.path, item.path, item.severity])).toEqual([
      ['shapes/circle', 'public/hero.png', 'error'],
      ['tools/lint', 'static/f.ttf', 'info'],
      ['tools/lint', 'static/b.jpg', 'info'],
    ])
    expect(view.total).toBe(3)
    expect(view.nextCursor).toBeUndefined()
    expect(view.items[0]?.analysisId).toBe(view.repos[0]?.analysisId)
  })

  test('leaves out repositories whose assets analyzer is turned off', async () => {
    await store.settings.put({
      id: 'off',
      key: 'repo.analyzers',
      scope: { repos: ['work:tools/lint'] },
      value: { off: ['assets'], reason: 'Backend only' },
      secret: false,
      updatedAt: '2026-10-30T10:00:00.000Z',
    })
    const view = await overview('')
    expect(view.repos.map((repo) => repo.repo.path)).toEqual(['shapes/circle'])
    expect(paths(view)).toEqual(['public/hero.png'])
  })

  test('filters by status, kind, format, problem, group and repository and sorts', async () => {
    expect(paths(await overview('?status=policy'))).toEqual(['public/hero.png'])
    expect(paths(await overview('?status=saving'))).toEqual(['public/hero.png', 'static/f.ttf'])
    expect(paths(await overview('?kind=font'))).toEqual(['static/f.ttf'])
    expect(paths(await overview('?format=JPEG'))).toEqual(['static/b.jpg'])
    expect(paths(await overview('?problem=duplicate'))).toEqual(['static/b.jpg'])
    expect(paths(await overview('?sort=saving'))).toEqual([
      'public/hero.png',
      'static/f.ttf',
      'static/b.jpg',
    ])
    expect(paths(await overview('?sort=size&group=tools'))).toEqual([
      'static/f.ttf',
      'static/b.jpg',
    ])
    const one = await overview('?repo=work:tools/lint&status=policy&kind=')
    expect(one.repos.map((repo) => repo.repo.path)).toEqual(['tools/lint'])
    expect(one.items).toEqual([])
    expect(one.total).toBe(0)
    const bad = await setup().request('/api/assets?status=broken', { headers: asAdmin })
    expect(bad.status).toBe(400)
    expect((await setup().request('/api/assets?cursor=x', { headers: asAdmin })).status).toBe(400)
  })

  test('pages with a cursor and caps the page size', async () => {
    const first = await overview('?limit=2')
    expect(first.items.map((item) => item.path)).toEqual(['public/hero.png', 'static/f.ttf'])
    expect(first).toMatchObject({ total: 3, nextCursor: '2' })
    const second = await overview(`?limit=2&cursor=${first.nextCursor}`)
    expect(second.items.map((item) => item.path)).toEqual(['static/b.jpg'])
    expect(second.nextCursor).toBeUndefined()
    const row = (await overview('')).items[0]
    if (!row) throw new Error('no row')
    const many = { repos: [], items: Array.from({ length: 450 }, () => row) }
    const page = assetsPage(many, 0, 10_000)
    expect(page.items).toHaveLength(ASSETS_PAGE_MAX)
    expect(page.nextCursor).toBe(String(ASSETS_PAGE_MAX))
  })

  test('a narrow grant sees only its repositories; catalog readers see none', async () => {
    const tools = await overview('', asTools)
    expect(tools.repos.map((repo) => repo.repo.path)).toEqual(['tools/lint'])
    expect(tools.items.every((item) => item.repo.path === 'tools/lint')).toBe(true)
    expect((await overview('?repo=work:shapes/circle', asTools)).repos).toEqual([])
    expect(await overview('', asCatalog)).toEqual({ repos: [], items: [], total: 0 })
    expect((await setup().request('/api/assets', { headers: {} })).status).toBe(401)
  })

  test('reads only the newest heads, never record data, and the main line for branch runs', async () => {
    await add('shapes/circle', record(9_000_000), '2026-10-30T03:00:00.000Z', 'feature/x')
    const { spied, calls } = spy(store.analyses)
    const view = await overview('', asAdmin, spied)
    expect(view.repos[0]?.files).toBe(2)
    expect(view.repos.find((repo) => repo.repo.path === 'shapes/circle')?.bytes).toBe(1_201_000)
    expect(calls.map((call) => call.method).toSorted()).toEqual(['heads', 'latestHeads'])
    expect(calls.find((call) => call.method === 'latestHeads')?.query).toEqual({ kind: 'assets' })
    for (const call of calls.filter((entry) => entry.method === 'heads'))
      expect((call.query as { limit: number }).limit).toBeLessThanOrEqual(LINE_SCAN)
  })

  test('a newest record stored without metrics gets them from its data', async () => {
    await store.analyses.add({
      repo: { forge: 'work', path: 'tools/lint' },
      kind: 'assets',
      createdAt: '2026-10-30T03:00:00.000Z',
      data: record(1_200_000),
    })
    const view = await overview('?group=tools')
    expect(view.repos.map((repo) => [repo.repo.path, repo.bytes, repo.moreRows])).toEqual([
      ['tools/lint', 1_201_000, 0],
    ])
    expect(paths(view)).toEqual(['public/hero.png'])
  })

  test('a repo that is not forge:path answers 400', async () => {
    const response = await setup().request('/api/assets?repo=shapes', { headers: asAdmin })
    expect(response.status).toBe(400)
  })

  test('answers from the cache until a newer record lands', async () => {
    const { spied, calls } = spy(store.analyses)
    const app = setup(spied)
    const read = async (query: string) =>
      (await (
        await app.request(`/api/assets${query}`, { headers: asAdmin })
      ).json()) as AssetsOverview
    expect((await read('?limit=1')).total).toBe(3)
    expect((await read('?limit=1&cursor=1')).items.map((item) => item.path)).toEqual([
      'static/f.ttf',
    ])
    expect(calls.map((call) => call.method)).toEqual(['latestHeads', 'latestHeads'])
    await add('tools/lint', record(10), '2026-10-31T03:00:00.000Z')
    expect((await read('?limit=1')).total).toBe(2)
  })

  test('the sheet still reads one repository', async () => {
    const view = (await (
      await setup().request('/api/assets/repo?repo=work:tools/lint', { headers: asAdmin })
    ).json()) as RepoAssetsView
    expect(view.summary?.rows).toEqual(assetsSummary(lintRecord()).rows)
  })
})

const toolsFor = (readable: string[]) =>
  assetsToolset(
    storedAssetTools(store, {
      targetOf: (repo) => ({ ...repo, groups: [] }),
      canRead: (target) => readable.includes(`${target.forge}:${target.path}`),
      canReadScope: () => true,
    }),
  )

const grouped = (settings: boolean) =>
  storedAssetTools(store, {
    targetOf: (repo) => ({ ...repo, groups: ['shapes'] }),
    canRead: () => true,
    canReadScope: () => settings,
  }).policy('work:shapes/square')

const run = async (readable: string[], name: string, input: Record<string, unknown>) => {
  const tool = toolsFor(readable).tools.find((t) => t.name === name)
  if (!tool) throw new Error(`no tool ${name}`)
  return tool.run(tool.input.parse(input), {} as never)
}

describe('assets tools', () => {
  test('asset_policy states the policy and what applies to one path', async () => {
    await putPolicy({ repos: ['work:shapes/circle'] }, { formats: { raster: 'avif+webp' } })
    const text = await run(['work:shapes/circle'], 'asset_policy', {
      repo: 'work:shapes/circle',
      path: 'public/hero.png',
    })
    expect(text).toContain("from the repository's own entry")
    expect(text).toContain('ship with a AVIF and WEBP version')
    expect(text).toContain('- From 8 kB it needs AVIF and WEBP next to it')
    await putPolicy({ groups: ['shapes', 'circles'] }, {}, 'p2')
    expect(await grouped(false)).toMatchObject({ source: { level: 'group' } })
    expect((await grouped(false))?.source.entry).toBeUndefined()
    expect(await grouped(true)).toMatchObject({ source: { entry: { id: 'p2' } } })
    expect(pathFacts('vendor/x.png', defaultAssetsPolicy)).toEqual([
      '`vendor/x.png` is ignored: no limit or check applies.',
    ])
  })

  test('repo_assets lists offending files and respects what the caller may read', async () => {
    await add('shapes/circle', record(1_200_000), '2026-10-29T03:00:00.000Z')
    const text = await run(['work:shapes/circle'], 'repo_assets', { repo: 'work:shapes/circle' })
    expect(text).toContain('Policy: 1 errors, 0 warnings.')
    expect(text).toContain('- [error] `public/hero.png`')
    expect(text).toContain('saves')
    expect(run([], 'repo_assets', { repo: 'work:shapes/circle' })).rejects.toThrow(
      'No repository work:shapes/circle you can read.',
    )
    expect(await run(['work:tools/lint'], 'repo_assets', { repo: 'work:tools/lint' })).toContain(
      'No assets analysis of work:tools/lint yet',
    )
  })

  test('assetsPolicyFor falls back to the default without an entry', async () => {
    expect(
      await assetsPolicyFor(store, { forge: 'work', path: 'tools/lint', groups: ['tools'] }),
    ).toEqual({ policy: defaultAssetsPolicy })
  })
})
