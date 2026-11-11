import { beforeEach, describe, expect, test } from 'bun:test'

import type { RepoAssetsView } from '@holtkeeper/api'
import { type AssetsData, assetsAnalysis } from '@holtkeeper/assets'
import { defaultAssetsPolicy } from '@holtkeeper/assets'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'
import { assetsPolicyFor } from '../src/assets.ts'
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
  },
})
const asAdmin = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'admin' }
const asTools = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'tools' }

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

const setup = () => {
  const vault = aesVault('v'.repeat(32))
  return createApp({
    config,
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [assetsAnalysis],
    now: () => new Date('2026-10-30T12:00:00.000Z'),
  })
}

const add = (path: string, data: AssetsData, createdAt: string) =>
  store.analyses.add({ repo: { forge: 'work', path }, kind: 'assets', createdAt, data })

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
