import { beforeEach, describe, expect, test } from 'bun:test'

import type {
  CreateMcpTokenResult,
  McpTokenList,
  McpUsageOverview,
  PublicApiDiff,
  PublicApiPackageDetail,
  PublicApiPackageList,
  PublicApiSearchResult,
  PublicApiSymbol,
  PackageUsageView,
  PublishedPackagesView,
  RepoUsageView,
  UpgradeImpactView,
  UsageSitesView,
} from '@holtkeeper/api'
import type { ApiPackage, ApiSurfaceData } from '@holtkeeper/api-surface'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { KnowledgeEntry, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import type { UsagesData } from '@holtkeeper/usages'
import { aesVault } from '@holtkeeper/vault'

import { cachedCatalog, createApiCatalog } from '../src/api-surface/catalog.ts'
import { createApp } from '../src/app.ts'
import { createFleetCache } from '../src/fleet-cache.ts'

const workForge = {
  getRepository: async (path: string) => ({ path, defaultBranch: 'main' }),
  readFile: async () => undefined,
  listCommits: async () =>
    Array.from({ length: 12 }, (_, i) => ({
      parents: ['p'],
      title: `feat(scene): [GAME-${i}] add level ${i}`,
      message: `feat(scene): [GAME-${i}] add level ${i}`,
    })),
  listBranches: async () => [],
  getPushRules: async () => ({ branchName: '^(feat|fix)/' }),
}

const config = parseConfig({
  forges: {
    work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => workForge as never },
  },
  groups: {
    libs: { forge: 'work', include: ['libs/ui'] },
    games: { forge: 'work', include: ['games/a'] },
  },
})

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['*'] }],
    games: [{ scope: { groups: ['games'] }, actions: ['analyses:read', 'analyses:run'] }],
    readers: [{ scope: { groups: ['games'] }, actions: ['knowledge:read'] }],
  },
})
const asAdmin = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'admin' }
const asGames = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'games' }
const asReader = { 'x-forwarded-user': 'ann', 'x-forwarded-groups': 'readers' }

const ui = (version: string, names: string[]): ApiPackage => ({
  name: '@acme/ui',
  version,
  description: 'Buttons and links',
  private: false,
  dir: 'packages/ui',
  entries: [
    {
      subpath: '.',
      file: 'packages/ui/src/index.ts',
      symbols: names.map((name) => ({
        name,
        kind: 'function',
        signature: `function ${name}(): void`,
        doc: `Renders a ${name}.`,
        file: 'packages/ui/src/index.ts',
        line: 1,
      })),
    },
  ],
})

let store: Store
let app: ReturnType<typeof createApp>
let now = new Date('2026-10-30T12:00:00.000Z')

const add = (repo: string, data: ApiSurfaceData, createdAt: string, ref?: string) =>
  store.analyses.add({
    repo: { forge: 'work', path: repo },
    kind: 'api-surface',
    createdAt,
    data,
    ...(ref ? { ref } : {}),
  })

beforeEach(async () => {
  store = memoryStore()
  now = new Date('2026-10-30T12:00:00.000Z')
  const vault = aesVault('v'.repeat(32))
  app = createApp({
    config,
    auth,
    store,
    vault,
    credentials: createCredentialService({
      credentials: store.credentials,
      vault,
    }),
    settings: builtinSettings,
    analyses: [],
    now: () => now,
  })
  await add(
    'libs/ui',
    { packages: [ui('1.0.0', ['button', 'link'])] },
    '2026-10-01T00:00:00.000Z',
    'v1.0.0',
  )
  await add(
    'libs/ui',
    { packages: [ui('1.1.0', ['button', 'card'])] },
    '2026-10-10T00:00:00.000Z',
    'v1.1.0',
  )
  await add(
    'libs/ui',
    { packages: [ui('1.1.0', ['button', 'card', 'dialog'])] },
    '2026-10-20T00:00:00.000Z',
  )
  await add(
    'games/a',
    { packages: [{ ...ui('0.1.0', ['scene']), name: '@games/engine', dir: '.' }] },
    '2026-10-05T00:00:00.000Z',
  )
})

const get = async <T>(path: string, headers: Record<string, string> = asAdmin) => {
  const response = await app.request(path, { headers })
  expect(response.status).toBe(200)
  return (await response.json()) as T
}

const crossTeam = (level: 'off' | 'metadata' | 'snippets') =>
  store.settings.put({
    id: 'cross-team',
    key: 'access.crossTeam',
    scope: { all: true },
    value: level,
    secret: false,
    updatedAt: '2026-10-01T00:00:00.000Z',
  })

describe('catalog routes', () => {
  test('lists the newest version of each package the caller may read', async () => {
    const list = await get<PublicApiPackageList>('/api/api-surface/packages')
    expect(list.packages.map((p) => [p.name, p.version, p.exports, p.versions, p.ref])).toEqual([
      ['@acme/ui', '1.1.0', 3, 3, undefined],
      ['@games/engine', '0.1.0', 1, 1, undefined],
    ])
    expect(list.indexedAt).toBeDefined()
    const games = await get<PublicApiPackageList>('/api/api-surface/packages', asGames)
    expect(games.packages.map((p) => p.name)).toEqual(['@acme/ui', '@games/engine'])
    await crossTeam('off')
    const own = await get<PublicApiPackageList>('/api/api-surface/packages', asGames)
    expect(own.packages.map((p) => p.name)).toEqual(['@games/engine'])
    const filtered = await get<PublicApiPackageList>('/api/api-surface/packages?q=acme')
    expect(filtered.packages.map((p) => p.name)).toEqual(['@acme/ui'])
  })

  test('resolves latest, head and exact versions', async () => {
    const latest = await get<PublicApiPackageDetail>('/api/api-surface/package?name=@acme/ui')
    expect(latest.ref).toBe('v1.1.0')
    expect(latest.versions.map((v) => [v.version, v.head])).toEqual([
      ['1.1.0', true],
      ['1.1.0', false],
      ['1.0.0', false],
    ])
    const head = await get<PublicApiPackageDetail>(
      '/api/api-surface/package?name=@acme/ui&version=head',
    )
    expect(head.package.entries[0]?.symbols.map((s) => s.name)).toEqual([
      'button',
      'card',
      'dialog',
    ])
    const old = await get<PublicApiPackageDetail>(
      '/api/api-surface/package?name=@acme/ui&version=v1.0.0',
    )
    expect(old.package.version).toBe('1.0.0')
    await crossTeam('off')
    expect(
      (await app.request('/api/api-surface/package?name=@acme/ui', { headers: asGames })).status,
    ).toBe(404)
    const markdown = await app.request('/api/api-surface/package.md?name=@acme/ui&version=1.0.0', {
      headers: asAdmin,
    })
    expect(markdown.headers.get('content-type')).toContain('text/markdown')
    expect(await markdown.text()).toContain('### link (function)')
  })

  test('diffs a version with the release before it and searches symbols', async () => {
    const diff = await get<PublicApiDiff>('/api/api-surface/diff?name=@acme/ui&to=1.1.0')
    expect([diff.from.version, diff.to.version]).toEqual(['1.0.0', '1.1.0'])
    expect(diff.diff).toMatchObject({ removed: 1, added: 1, required: 'major', bumped: 'minor' })
    expect(diff.diff.semverWarning).toContain('not a major bump')

    const search = await get<PublicApiSearchResult>('/api/api-surface/search?q=card')
    expect(search.hits.map((hit) => [hit.importPath, hit.symbol.name, hit.version])).toEqual([
      ['@acme/ui', 'card', '1.1.0'],
    ])
    const byDoc = await get<PublicApiSearchResult>('/api/api-surface/search?q=renders&limit=2')
    expect(byDoc.hits).toHaveLength(2)
    expect(byDoc.more).toBe(2)
  })
})

const status = async (path: string, headers: Record<string, string> = asAdmin) =>
  (await app.request(path, { headers })).status

describe('catalog facets and matches', () => {
  test('packages carry their match and facets counted before the repo and kind filters', async () => {
    const byName = await get<PublicApiPackageList>('/api/api-surface/packages?q=ui')
    expect(byName.packages.map((p) => [p.name, p.match])).toEqual([['@acme/ui', 'part']])
    const byDoc = await get<PublicApiPackageList>('/api/api-surface/packages?q=buttons')
    expect(byDoc.packages.map((p) => [p.name, p.match])).toEqual([
      ['@acme/ui', 'doc'],
      ['@games/engine', 'doc'],
    ])
    const narrowed = await get<PublicApiPackageList>(
      '/api/api-surface/packages?repo=work:games/a&kind=function',
    )
    expect(narrowed.packages.map((p) => p.name)).toEqual(['@games/engine'])
    expect(narrowed.packages[0]?.match).toBeUndefined()
    expect(narrowed.facets).toEqual({
      kinds: [{ value: 'function', count: 2 }],
      packages: [
        { value: '@acme/ui', count: 1 },
        { value: '@games/engine', count: 1 },
      ],
      repos: [
        { value: 'work:games/a', count: 1 },
        { value: 'work:libs/ui', count: 1 },
      ],
    })
    expect(
      (await get<PublicApiPackageList>('/api/api-surface/packages?kind=class')).packages,
    ).toEqual([])
    expect(await status('/api/api-surface/packages?kind=widget')).toBe(400)
  })

  test('search hits carry match, ref, deprecated and removed, with facets before the filters', async () => {
    await add(
      'libs/ui',
      {
        packages: [
          {
            ...ui('1.2.0', ['card']),
            entries: [
              {
                subpath: '.',
                symbols: [
                  {
                    name: 'card',
                    kind: 'function',
                    signature: 'function card(): void',
                    deprecated: 'use panel',
                    file: 'packages/ui/src/index.ts',
                    line: 1,
                  },
                ],
              },
              {
                subpath: './cards',
                symbols: [
                  {
                    name: 'cardList',
                    kind: 'variable',
                    signature: 'const cardList: string[]',
                    file: 'packages/ui/src/cards.ts',
                    line: 1,
                  },
                ],
              },
            ],
          },
        ],
      },
      '2026-10-28T00:00:00.000Z',
      'v1.2.0',
    )
    const result = await get<PublicApiSearchResult>('/api/api-surface/search?q=card')
    expect(
      result.hits.map((hit) => [hit.importPath, hit.symbol.name, hit.match, hit.deprecated]),
    ).toEqual([
      ['@acme/ui', 'card', 'exact', true],
      ['@acme/ui/cards', 'cardList', 'prefix', false],
    ])
    expect(result.hits[0]).toMatchObject({ ref: 'v1.2.0', removed: false, subpath: '.' })
    expect(result.facets.matches).toEqual([
      { value: 'exact', count: 1 },
      { value: 'prefix', count: 1 },
    ])
    expect(result.facets.subpaths).toEqual([
      { value: '.', count: 1 },
      { value: './cards', count: 1 },
    ])
    expect(result.facets.kinds).toEqual([
      { value: 'function', count: 1 },
      { value: 'variable', count: 1 },
    ])
    const prefixOnly = await get<PublicApiSearchResult>(
      '/api/api-surface/search?q=card&match=prefix&subpath=./cards',
    )
    expect(prefixOnly.hits.map((hit) => hit.symbol.name)).toEqual(['cardList'])
    expect(prefixOnly.facets.matches).toHaveLength(2)
    expect(await status('/api/api-surface/search?q=card&match=fuzzy')).toBe(400)

    const scene = await get<PublicApiSearchResult>('/api/api-surface/search?q=scene')
    expect(scene.hits.map((hit) => [hit.package, hit.removed, hit.ref])).toEqual([
      ['@games/engine', false, undefined],
    ])
    const inRepo = await get<PublicApiSearchResult>(
      '/api/api-surface/search?q=card&repo=work:games/a',
    )
    expect(inRepo.hits).toEqual([])
    expect(inRepo.facets.repos).toEqual([{ value: 'work:libs/ui', count: 2 }])
  })

  test('search marks symbols of packages their repository dropped', async () => {
    const other = { ...ui('1.0.0', ['tab']), name: '@acme/other', dir: 'packages/other' }
    await add('libs/ui', { packages: [other] }, '2026-10-25T00:00:00.000Z')
    await add('libs/ui', { packages: [other] }, '2026-10-26T00:00:00.000Z')
    const result = await get<PublicApiSearchResult>('/api/api-surface/search?q=dialog')
    expect(result.hits.map((hit) => [hit.package, hit.removed])).toEqual([['@acme/ui', true]])
  })

  test('narrow grants see neither packages nor hits of other teams', async () => {
    await crossTeam('off')
    const list = await get<PublicApiPackageList>('/api/api-surface/packages', asGames)
    expect(list.packages.map((p) => p.name)).toEqual(['@games/engine'])
    expect(list.facets.repos).toEqual([{ value: 'work:games/a', count: 1 }])
    const search = await get<PublicApiSearchResult>('/api/api-surface/search?q=renders', asGames)
    expect(search.hits.map((hit) => hit.symbol.name)).toEqual(['scene'])
    expect(search.facets.packages).toEqual([{ value: '@games/engine', count: 1 }])
  })
})

const everything = () => true

describe('symbol route', () => {
  test('answers one symbol with the versions where it changed', async () => {
    const card = await get<PublicApiSymbol>('/api/api-surface/symbol?package=@acme/ui&name=card')
    expect(card).toMatchObject({
      package: '@acme/ui',
      version: '1.1.0',
      ref: 'v1.1.0',
      subpath: '.',
      importPath: '@acme/ui',
      alsoIn: [],
    })
    expect(card.symbol.signature).toBe('function card(): void')
    expect(card.history).toEqual({
      changes: [
        {
          version: '1.1.0',
          ref: 'v1.1.0',
          analyzedAt: '2026-10-10T00:00:00.000Z',
          change: 'added',
          after: 'function card(): void',
        },
      ],
      versions: 3,
      capped: false,
    })

    const link = await get<PublicApiSymbol>(
      '/api/api-surface/symbol?package=@acme/ui&name=link&version=1.0.0',
    )
    expect(link.history.changes.map((change) => [change.version, change.change])).toEqual([
      ['1.1.0', 'removed'],
      ['1.0.0', 'added'],
    ])
  })

  test('caps the history and rejects bad limits', async () => {
    const capped = await get<PublicApiSymbol>(
      '/api/api-surface/symbol?package=@acme/ui&name=button&limit=2',
    )
    expect(capped.history).toEqual({ changes: [], versions: 2, capped: true })
    for (const limit of ['0', '101', 'two', '1.5'])
      // oxlint-disable-next-line no-await-in-loop -- one request per case
      expect(
        await status(`/api/api-surface/symbol?package=@acme/ui&name=button&limit=${limit}`),
      ).toBe(400)
    expect(await status('/api/api-surface/symbol?package=@acme/ui')).toBe(400)
  })

  test('symbols and packages nobody may read are not found', async () => {
    expect(await status('/api/api-surface/symbol?package=@acme/ui&name=missing')).toBe(404)
    expect(await status('/api/api-surface/symbol?package=@acme/none&name=button')).toBe(404)
    expect(await status('/api/api-surface/symbol?package=@acme/ui&name=card', asGames)).toBe(200)
    await crossTeam('off')
    expect(await status('/api/api-surface/symbol?package=@acme/ui&name=card', asGames)).toBe(404)
    expect(await status('/api/api-surface/symbol?package=@games/engine&name=scene', asGames)).toBe(
      200,
    )
  })

  test('answers from the cache until the records the caller sees change', async () => {
    const catalog = createApiCatalog({ analyses: store.analyses, refreshMs: 0 })
    const cache = createFleetCache()
    let loads = 0
    const read = (canRead: (repo: { path: string }) => boolean) =>
      cachedCatalog(cache, catalog, canRead, 'api-surface/symbol?name=card', async () => {
        loads += 1
        return catalog.symbol(canRead, { package: '@acme/ui', name: 'card', limit: 20 })
      })
    const first = await read(everything)
    expect(await read(everything)).toBe(first)
    expect(loads).toBe(1)
    await read((repo) => repo.path === 'games/a')
    expect(loads).toBe(2)
    await add(
      'libs/ui',
      { packages: [ui('1.1.0', ['button', 'card', 'dialog', 'menu'])] },
      '2026-10-29T00:00:00.000Z',
    )
    expect((await read(everything))?.analysisId).toBe(first?.analysisId)
    expect(loads).toBe(3)
  })
})

const rpc = (body: unknown, headers: Record<string, string>) =>
  app.request('/mcp', {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'user-agent': 'claude-code/2.1.0 (test)',
    },
    body: JSON.stringify(body),
  })

const callTool = async (
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string>,
) => {
  const response = await rpc(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    headers,
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    result: { content: { text: string }[]; isError?: boolean }
  }
  return body.result
}

describe('removed packages', () => {
  const kit = { ...ui('2.0.0', ['button']), name: '@acme/kit' }
  const other = { ...ui('1.0.0', ['tab']), name: '@acme/other', dir: 'packages/other' }

  test('are marked once two non-empty default branch runs lack them, with their likely new name', async () => {
    await add('libs/ui', { packages: [kit] }, '2026-10-25T00:00:00.000Z')
    const once = await createApiCatalog({ analyses: store.analyses }).packages(() => true)
    expect(once.find((p) => p.name === '@acme/ui')?.removed).toBeUndefined()

    await add('libs/ui', { packages: [kit] }, '2026-10-26T00:00:00.000Z')
    const list = await get<PublicApiPackageList>('/api/api-surface/packages')
    const removed = list.packages.find((p) => p.name === '@acme/ui')
    expect(removed?.version).toBe('1.1.0')
    expect(removed?.removed).toEqual({ at: '2026-10-25T00:00:00.000Z', renamedTo: '@acme/kit' })
    expect(list.packages.find((p) => p.name === '@acme/kit')?.removed).toBeUndefined()

    const detail = await get<PublicApiPackageDetail>('/api/api-surface/package?name=@acme/ui')
    expect(detail.removed?.renamedTo).toBe('@acme/kit')

    const packages = await callTool('list_packages', {}, asAdmin)
    const text = packages.content[0]?.text ?? ''
    expect(text.indexOf('Removed from their repositories')).toBeLessThan(
      text.indexOf('**@acme/ui**'),
    )
    expect(text).toContain(
      '**Removed:** `work:libs/ui` dropped @acme/ui on 2026-10-25; do not use it in new code',
    )
    const api = await callTool('get_package_api', { package: '@acme/ui' }, asAdmin)
    expect(api.content[0]?.text).toStartWith('**Removed:**')
  })

  test('point at repositories that still have them and resolve there by default', async () => {
    await add('libs/ui', { packages: [] }, '2026-10-24T00:00:00.000Z')
    await add('libs/ui', { packages: [] }, '2026-10-24T01:00:00.000Z')
    const empty = await createApiCatalog({ analyses: store.analyses }).packages(() => true)
    expect(empty.find((p) => p.name === '@acme/ui')?.removed).toBeUndefined()

    await add('libs/ui', { packages: [other] }, '2026-10-25T00:00:00.000Z')
    await add('libs/ui', { packages: [other] }, '2026-10-26T00:00:00.000Z')
    await add('games/a', { packages: [ui('1.2.0', ['button'])] }, '2026-10-27T00:00:00.000Z')

    const list = await get<PublicApiPackageList>('/api/api-surface/packages')
    const removed = list.packages.find((p) => p.name === '@acme/ui' && p.repo.path === 'libs/ui')
    expect(removed?.removed?.movedTo).toEqual([{ forge: 'work', path: 'games/a' }])
    expect(
      list.packages.find((p) => p.name === '@acme/ui' && p.repo.path === 'games/a')?.removed,
    ).toBeUndefined()

    const detail = await get<PublicApiPackageDetail>('/api/api-surface/package?name=@acme/ui')
    expect(detail.repo.path).toBe('games/a')
    expect(detail.removed).toBeUndefined()
    const old = await get<PublicApiPackageDetail>(
      '/api/api-surface/package?name=@acme/ui&repo=work:libs/ui',
    )
    expect(old.removed?.movedTo).toEqual([{ forge: 'work', path: 'games/a' }])
  })

  test('removed in two repositories, they point at neither', async () => {
    await add('games/a', { packages: [ui('1.2.0', ['button'])] }, '2026-10-21T00:00:00.000Z')
    for (const repo of ['libs/ui', 'games/a'])
      for (const day of ['25', '26'])
        // oxlint-disable-next-line no-await-in-loop -- records must keep their order
        await add(repo, { packages: [other] }, `2026-10-${day}T00:00:00.000Z`)
    const list = await get<PublicApiPackageList>('/api/api-surface/packages')
    expect(
      list.packages.filter((p) => p.name === '@acme/ui').map((p) => p.removed?.movedTo),
    ).toEqual([undefined, undefined])
    expect(list.packages.filter((p) => p.name === '@acme/ui' && p.removed)).toHaveLength(2)
  })
})

const releaseToolsOf = async (headers: Record<string, string>) =>
  (
    (await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers)).json()) as {
      result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] }
    }
  ).result.tools.filter((tool) => tool.name.startsWith('release_'))

describe('MCP endpoint', () => {
  test('rejects anonymous requests and answers tools for token holders', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, {})).status).toBe(401)

    const created = await app.request('/api/api-surface/mcp/tokens', {
      method: 'POST',
      headers: { ...asGames, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'laptop', expiresInDays: 30 }),
    })
    expect(created.status).toBe(201)
    const { secret, token } = (await created.json()) as CreateMcpTokenResult
    expect(secret).toStartWith('hk_mcp_')
    expect(token).toMatchObject({ name: 'laptop', expiresAt: '2026-11-29T12:00:00.000Z' })
    const bearer = { authorization: `Bearer ${secret}` }

    const init = await rpc(
      {
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 't', version: '1' },
        },
      },
      bearer,
    )
    expect(init.status).toBe(200)
    const list = (await (
      await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, bearer)
    ).json()) as {
      result: { tools: { name: string }[] }
    }
    expect(list.result.tools.map((t) => t.name)).toEqual([
      'list_packages',
      'get_package_api',
      'search_symbols',
      'get_symbol',
      'list_versions',
      'diff_versions',
      'package_usage',
      'find_usages',
      'upgrade_impact',
      'repo_packages',
      'evaluate_dependency',
      'who_uses',
      'security_findings',
      'license_overview',
      'stack_usage',
      'repo_stack',
      'search_knowledge',
      'get_knowledge',
      'propose_knowledge',
      'repo_rules',
      'propose_rule_change',
      'commit_conventions',
      'check_commit_message',
      'test_ids',
      'suggest_test_ids',
      'asset_policy',
      'repo_assets',
      'release_rules',
      'release_status',
      'release_changes',
      'jobs',
      'job_log',
      'queue_stats',
      'why_job',
      'analysis_status',
      'fleet_health',
      'start_task',
      'task_status',
      'request_review',
    ])

    const reached = await callTool('list_packages', {}, bearer)
    expect(reached.content[0]?.text).toContain('**@acme/ui**@1.1.0')
    await crossTeam('off')
    const packages = await callTool('list_packages', {}, bearer)
    expect(packages.content[0]?.text).toContain('**@games/engine**@0.1.0')
    expect(packages.content[0]?.text).not.toContain('@acme/ui')
    const hidden = await callTool('get_package_api', { package: '@acme/ui' }, bearer)
    expect(hidden.isError).toBe(true)
    const rules = await callTool('repo_rules', { repo: 'work:games/a' }, bearer)
    expect(rules.isError).toBe(true)
    const proposal = await callTool(
      'propose_rule_change',
      { repo: 'work:games/a', section: 'general', rule: 'Name scenes after levels.', reason: 'x' },
      bearer,
    )
    expect(proposal.isError).toBe(true)
    expect(await store.learnings.list()).toEqual([])
    const testIds = await callTool('test_ids', { repo: 'work:games/a' }, bearer)
    expect(testIds.content[0]?.text).toContain('No test id catalog for `work:games/a` yet')
    expect((await callTool('test_ids', { repo: 'work:libs/ui' }, bearer)).isError).toBe(true)

    const tokens = await get<McpTokenList>('/api/api-surface/mcp/tokens', bearer)
    expect(tokens.tokens.map((t) => t.name)).toEqual(['laptop'])
    expect(
      (
        await app.request('/api/api-surface/mcp/tokens', {
          method: 'POST',
          headers: { ...bearer, 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'more' }),
        })
      ).status,
    ).toBe(401)

    const revoked = await app.request(`/api/api-surface/mcp/tokens/${token.id}`, {
      method: 'DELETE',
      headers: asGames,
    })
    expect(revoked.status).toBe(204)
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, bearer)).status).toBe(401)
  })

  test('offers release_step only to tokens with the release scope', async () => {
    const issue = async (body: Record<string, unknown>) =>
      (await (
        await app.request('/api/api-surface/mcp/tokens', {
          method: 'POST',
          headers: { ...asAdmin, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json()) as CreateMcpTokenResult
    const reader = await issue({ name: 'reader' })
    expect(reader.token.scopes).toBeUndefined()
    expect(
      (await releaseToolsOf({ authorization: `Bearer ${reader.secret}` })).map((t) => t.name),
    ).toEqual(['release_rules', 'release_status', 'release_changes'])

    const releaser = await issue({ name: 'releaser', scopes: ['release'] })
    expect(releaser.token.scopes).toEqual(['release'])
    const tools = await releaseToolsOf({ authorization: `Bearer ${releaser.secret}` })
    expect(tools.map((t) => [t.name, t.annotations?.readOnlyHint])).toEqual([
      ['release_rules', true],
      ['release_status', true],
      ['release_changes', true],
      ['release_step', false],
    ])
    expect((await releaseToolsOf(asAdmin)).map((t) => t.name)).not.toContain('release_step')
    expect(
      (await releaseToolsOf({ ...asAdmin, authorization: 'Bearer hk_mcp_unknown' })).map(
        (t) => t.name,
      ),
    ).not.toContain('release_step')
  })

  test('tools render APIs, versions and diffs, and usage is counted', async () => {
    const api = await callTool(
      'get_package_api',
      { package: '@acme/ui', version: '1.0.0' },
      asAdmin,
    )
    expect(api.content[0]?.text).toContain('# @acme/ui@1.0.0')
    expect(api.content[0]?.text).toContain('Other recorded versions: head, 1.1.0.')

    const symbol = await callTool('get_symbol', { package: '@acme/ui', name: 'card' }, asAdmin)
    expect(symbol.content[0]?.text).toContain("import { card } from '@acme/ui'")

    const versions = await callTool('list_versions', { package: '@acme/ui' }, asAdmin)
    expect(versions.content[0]?.text).toContain(
      '- 1.1.0 tag `v1.1.0`, 2026-10-10, 2 exports — since 1.0.0: 1 removed, 0 changed, 1 added',
    )

    const diff = await callTool(
      'diff_versions',
      { package: '@acme/ui', from: '1.1.0', to: 'head' },
      asAdmin,
    )
    expect(diff.content[0]?.text).toContain('## added: `@acme/ui → dialog` (function)')

    const missing = await callTool('get_package_api', { package: 'ui' }, asAdmin)
    expect(missing).toMatchObject({ isError: true })
    expect(missing.content[0]?.text).toContain('Similar: @acme/ui')

    const usage = await get<McpUsageOverview>('/api/api-surface/mcp/usage?days=7')
    expect(usage.totals).toEqual({ calls: 5, errors: 1, people: 1 })
    expect(usage.days.at(-1)).toEqual({ date: '2026-10-30', calls: 5, errors: 1 })
    expect(usage.tools[0]).toEqual({ tool: 'get_package_api', calls: 2, errors: 1 })
    expect(usage.packages[0]).toEqual({ name: '@acme/ui', calls: 4 })
    expect(usage.clients).toEqual([{ client: 'claude-code/2.1.0', calls: 5 }])
    expect(usage.recent[0]).toMatchObject({
      tool: 'get_package_api',
      ok: false,
      principal: 'header:jane',
    })
    expect(usage.endpoint).toBe('http://localhost/mcp')

    const own = await get<McpUsageOverview>('/api/api-surface/mcp/usage', asGames)
    expect(own.people).toEqual([])
    expect(own.recent).toEqual([])
  })

  test('usage per person and token stays with its owner unless the viewer may read users', async () => {
    const created = await app.request('/api/api-surface/mcp/tokens', {
      method: 'POST',
      headers: { ...asGames, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'laptop' }),
    })
    const { secret, token } = (await created.json()) as CreateMcpTokenResult
    const bearer = { authorization: `Bearer ${secret}` }
    await callTool('list_packages', {}, bearer)
    expect(await callTool('get_package_api', { package: 'nope' }, bearer)).toMatchObject({
      isError: true,
    })
    await callTool('list_packages', {}, asGames)
    await callTool('list_packages', {}, asAdmin)

    const own = await get<McpUsageOverview>('/api/api-surface/mcp/usage?days=7', asGames)
    const bob = {
      id: 'header:bob',
      name: 'bob',
      calls: 3,
      errors: 1,
      lastAt: '2026-10-30T12:00:00.000Z',
      tools: [
        { tool: 'list_packages', calls: 2 },
        { tool: 'get_package_api', calls: 1 },
      ],
      packages: [{ name: 'nope', calls: 1 }],
      clients: [{ client: 'claude-code/2.1.0', calls: 3 }],
      daily: [0, 0, 0, 0, 0, 0, 3],
      dailyErrors: [0, 0, 0, 0, 0, 0, 1],
      teams: ['games'],
      activeTokens: 1,
    }
    expect(own.people).toEqual([bob])
    expect(own.me).toEqual(bob)
    expect(own.tokens).toEqual([{ id: token.id, calls: 2 }])
    expect(own.recent.map((call) => call.principal)).toEqual([
      'header:bob',
      'header:bob',
      'header:bob',
    ])

    const all = await get<McpUsageOverview>('/api/api-surface/mcp/usage?days=7')
    expect(all.people.map((person) => [person.id, person.calls])).toEqual([
      ['header:bob', 3],
      ['header:jane', 1],
    ])
    expect(all.people[0]).toMatchObject({ teams: [], activeTokens: 1 })
    expect(all.me).toMatchObject({ id: 'header:jane', calls: 1, errors: 0, activeTokens: 0 })
    expect(all.tokens).toEqual([])
  })
})

const gameUsage = (version: string): UsagesData => ({
  packages: [
    {
      name: '@acme/ui',
      versions: [version],
      ranges: [`^${version}`],
      workspaces: ['root'],
      count: 3,
      files: 2,
      exports: [
        {
          name: 'link',
          subpath: '.',
          count: 1,
          files: 1,
          kinds: { call: 1 },
          members: [],
          props: [],
          spread: 0,
          sites: [
            {
              file: 'src/menu.ts',
              line: 4,
              column: 3,
              kind: 'call',
              snippet: "link('/home')",
              snippetLine: 4,
            },
          ],
        },
        {
          name: 'button',
          subpath: '.',
          count: 2,
          files: 1,
          kinds: { jsx: 2 },
          members: [],
          props: [{ name: 'variant', count: 2 }],
          spread: 0,
          sites: [
            {
              file: 'src/hud.tsx',
              line: 9,
              column: 7,
              kind: 'jsx',
              props: ['variant'],
              snippet: '<Button variant="ghost" />',
              snippetLine: 9,
            },
          ],
          truncated: 1,
        },
      ],
    },
  ],
  files: 12,
  types: { status: 'used', projects: ['tsconfig.json'], sites: 0 },
})

describe('usage routes and tools', () => {
  beforeEach(async () => {
    await store.analyses.add({
      repo: { forge: 'work', path: 'games/a' },
      kind: 'usages',
      createdAt: '2026-10-21T00:00:00.000Z',
      data: gameUsage('1.0.0'),
    })
  })

  test('shows who uses a package, the sites and what one repository uses', async () => {
    const usage = await get<PackageUsageView>('/api/api-surface/usages/package?name=@acme/ui')
    expect(usage.versions).toEqual(['1.0.0'])
    expect(usage.repos.map((r) => [r.repo.path, r.count, r.exports.map((e) => e.name)])).toEqual([
      ['games/a', 3, ['link', 'button']],
    ])
    expect(usage.repos[0]?.exports[0]).not.toHaveProperty('sites')
    expect(usage.exports.find((e) => e.name === 'button')?.props).toEqual([
      { name: 'variant', count: 2 },
    ])

    const sites = await get<UsageSitesView>(
      '/api/api-surface/usages/sites?package=@acme/ui&prop=variant',
    )
    expect(sites.sites.map((s) => [s.origin.path, s.export, s.site.file])).toEqual([
      ['games/a', 'button', 'src/hud.tsx'],
    ])

    const repo = await get<RepoUsageView>('/api/api-surface/usages/repo?repo=work:games/a', asGames)
    expect(repo.packages).toEqual([
      {
        name: '@acme/ui',
        versions: ['1.0.0'],
        ranges: ['^1.0.0'],
        local: false,
        count: 3,
        files: 2,
        exports: 2,
      },
    ])
    const hidden = await app.request('/api/api-surface/usages/repo?repo=work:games/a', {
      headers: { 'x-forwarded-user': 'eve', 'x-forwarded-groups': 'nobody' },
    })
    expect(hidden.status).toBe(404)
  })

  test('counts the uses of the packages one repository defines', async () => {
    const published = await get<PublishedPackagesView>(
      '/api/api-surface/usages/published?repo=work:libs/ui',
    )
    expect(published.packages).toEqual([
      {
        name: '@acme/ui',
        version: '1.1.0',
        description: 'Buttons and links',
        private: false,
        dir: 'packages/ui',
        exports: 3,
        repos: 1,
        count: 3,
        files: 2,
      },
    ])
    const games = await get<PublishedPackagesView>(
      '/api/api-surface/usages/published?repo=work:games/a',
    )
    expect(games.packages.map((p) => [p.name, p.repos])).toEqual([['@games/engine', 0]])
    await crossTeam('off')
    const hidden = await get<PublishedPackagesView>(
      '/api/api-surface/usages/published?repo=work:libs/ui',
      asGames,
    )
    expect(hidden.packages).toEqual([])
  })

  test('joins an API diff with the uses it breaks', async () => {
    const impact = await get<UpgradeImpactView>(
      '/api/api-surface/usages/impact?package=@acme/ui&from=1.0.0&to=1.1.0',
    )
    expect([impact.from.version, impact.to.version]).toEqual(['1.0.0', '1.1.0'])
    expect(
      impact.impact.items.map((i) => [i.level, i.change.name, i.repos[0]?.origin.path]),
    ).toEqual([['breaking', 'link', 'games/a']])

    const text = await callTool(
      'upgrade_impact',
      { package: '@acme/ui', from: '1.0.0', to: '1.1.0' },
      asAdmin,
    )
    expect(text.content[0]?.text).toContain('## breaking: removed `@acme/ui` → link (1 uses)')
    expect(text.content[0]?.text).toContain("link('/home')")

    const used = await callTool('package_usage', { package: '@acme/ui' }, asAdmin)
    expect(used.content[0]?.text).toContain(
      '- `work:games/a` (team games) — 1.0.0, 3 uses in 2 files, 2 exports',
    )
    const found = await callTool('find_usages', { package: '@acme/ui', export: 'button' }, asAdmin)
    expect(found.content[0]?.text).toContain('`src/hud.tsx:9` — jsx props `variant`')
    const packages = await callTool('repo_packages', { repo: 'work:games/a' }, asAdmin)
    expect(packages.content[0]?.text).toContain(
      '- **@acme/ui** 1.0.0 — 3 uses in 2 files, 2 exports',
    )
  })
})

const entry = (id: string, fields: Partial<KnowledgeEntry>) =>
  store.knowledge.put({
    id,
    title: `Entry ${id}`,
    body: 'Body.',
    kind: 'decision',
    scope: { all: true },
    topics: [],
    appliesTo: ['*'],
    status: 'accepted',
    evidence: [],
    source: 'human',
    author: 'header:jane',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...fields,
  })

describe('knowledge tools', () => {
  beforeEach(async () => {
    await entry('dates', {
      title: 'Use date-fns instead of moment',
      body: 'moment is frozen; new code formats dates with date-fns.',
      scope: { groups: ['games'] },
      packages: [{ ecosystem: 'npm', name: 'moment' }],
    })
    await entry('tokens', {
      title: 'Design tokens come from @acme/ui',
      body: 'Never hardcode colors.',
      scope: { repos: ['work:libs/ui'] },
    })
    await entry('draft', { title: 'Maybe drop moment', status: 'proposed' })
  })

  test('search accepted entries, by repository and in full', async () => {
    const found = await callTool('search_knowledge', { query: 'moment' }, asAdmin)
    expect(found.content[0]?.text).toContain('### [kb:dates] Use date-fns instead of moment')
    expect(found.content[0]?.text).not.toContain('Maybe drop moment')

    const forUi = await callTool('search_knowledge', { repo: 'work:libs/ui' }, asAdmin)
    expect(forUi.content[0]?.text).toContain('[kb:tokens]')
    expect(forUi.content[0]?.text).not.toContain('[kb:dates]')

    const draft = await callTool('get_knowledge', { id: '[kb:draft]' }, asAdmin)
    expect(draft.content[0]?.text).toContain('status: proposed (not reviewed yet')

    const denied = await callTool('search_knowledge', { repo: 'work:games/a' }, asGames)
    expect(denied.isError).toBe(true)
    expect((await callTool('get_knowledge', { id: 'dates' }, asGames)).isError).toBe(true)
  })

  test('proposals wait for review and duplicates are not added', async () => {
    const proposed = await callTool(
      'propose_knowledge',
      {
        title: 'Scenes unload their textures',
        body: 'Call scene.dispose() before switching levels, or textures leak.',
        repo: 'work:games/a',
        evidence: [{ label: 'MR', url: 'https://gitlab.test/games/a/-/merge_requests/7' }],
      },
      asAdmin,
    )
    expect(proposed.content[0]?.text).toContain('for `work:games/a`')
    const stored = (await store.knowledge.list({ status: 'proposed' })).find((item) =>
      item.title.startsWith('Scenes'),
    )
    expect(stored).toMatchObject({
      source: 'agent',
      author: 'header:jane',
      scope: { repos: ['work:games/a'] },
    })

    const again = await callTool(
      'propose_knowledge',
      { title: 'Scenes unload their textures', body: 'Other words.', repo: 'work:games/a' },
      asAdmin,
    )
    expect(again.content[0]?.text).toStartWith(`Not added: [kb:${stored?.id}] (proposed)`)

    const denied = await callTool(
      'propose_knowledge',
      { title: 'Anything', body: 'Anything.', repo: 'work:games/a' },
      asGames,
    )
    expect(denied.isError).toBe(true)
  })
})

describe('rules tools', () => {
  test('repo_rules resolves the Guide and propose_rule_change leaves an audited candidate', async () => {
    await store.guides.put({
      scope: 'group:games',
      section: 'general',
      rules: 'Scenes own their assets.',
      steering: '',
      learnings: [],
    })
    const rules = await callTool('repo_rules', { repo: 'work:games/a' }, asAdmin)
    expect(rules.content[0]?.text).toContain('Scenes own their assets.')

    const proposed = await callTool(
      'propose_rule_change',
      {
        repo: 'work:games/a',
        section: 'general',
        rule: 'Unload scene textures on exit.',
        reason: 'Leaks in two merge requests.',
        scope: 'group',
      },
      asAdmin,
    )
    expect(proposed.content[0]?.text).toStartWith('Proposed "Unload scene textures on exit."')
    const [candidate] = await store.learnings.list()
    expect(candidate).toMatchObject({
      repo: 'work:games/a',
      suggestedScope: 'group',
      proposal: { by: 'header:jane', reason: 'Leaks in two merge requests.' },
    })
    const events = await store.audit.list({ action: 'learning.propose' })
    expect(events.events.map((event) => [event.target.id, event.target.repo])).toEqual([
      [candidate?.id, 'work:games/a'],
    ])

    const targeted = await callTool(
      'propose_rule_change',
      {
        repo: 'work:games/a',
        section: 'general',
        rule: 'Preload scene audio.',
        reason: 'Stutters on first play.',
        scope: 'group:games',
      },
      asAdmin,
    )
    expect(targeted.content[0]?.text).toContain('into group:games.')
    const foreign = await callTool(
      'propose_rule_change',
      {
        repo: 'work:games/a',
        section: 'general',
        rule: 'Bake scene lights.',
        reason: 'Slow loads.',
        scope: 'group:elsewhere',
      },
      asAdmin,
    )
    expect(foreign.isError).toBe(true)
    expect(
      (await store.learnings.list())
        .map((each) => [each.rule, each.targetScope])
        .toSorted(([a], [b]) => String(a).localeCompare(String(b))),
    ).toEqual([
      ['Preload scene audio.', 'group:games'],
      ['Unload scene textures on exit.', undefined],
    ])
  })
})

const autoAccept = (
  value: unknown,
  scope: { all: true } | { groups: string[] } | { repos: string[] } = { all: true },
) =>
  store.settings.put({
    id: `learnings.autoAccept:${JSON.stringify(scope)}`,
    key: 'learnings.autoAccept',
    scope,
    value,
    secret: false,
    updatedAt: '2026-10-01T00:00:00.000Z',
  })
const propose = (rule: string, scope?: string, headers = asAdmin) =>
  callTool(
    'propose_rule_change',
    {
      repo: 'work:games/a',
      section: 'general',
      rule,
      reason: 'Seen twice.',
      ...(scope && { scope }),
    },
    headers,
  )

describe('learnings auto-accept', () => {
  test('stays proposed while the policy is off or leaves MCP out', async () => {
    await autoAccept({ sources: ['review-reply'], scope: 'suggested' })
    const result = await propose('Unload scene textures on exit.', 'group')
    expect(result.content[0]?.text).toStartWith('Proposed ')
    const [candidate] = await store.learnings.list()
    expect(candidate?.status).toBe('proposed')
    expect((await store.guides.list()).flatMap((row) => row.learnings)).toEqual([])
    expect((await store.audit.list({ action: 'learning.accept' })).events).toEqual([])
  })

  test('accepts into the suggested scope, audited as auto-accept and still rejectable', async () => {
    await autoAccept({ sources: ['mcp'], scope: 'suggested' })
    const result = await propose('Unload scene textures on exit.', 'group:games')
    expect(result.content[0]?.text).toStartWith('Accepted "Unload scene textures on exit."')
    expect(result.content[0]?.text).toContain('into group:games')
    const [candidate] = await store.learnings.list()
    expect(candidate).toMatchObject({
      status: 'accepted',
      acceptedScope: 'group:games',
      decidedBy: 'auto-accept',
    })
    const row = await store.guides.get('group:games', 'general')
    expect(row?.learnings).toMatchObject([
      { id: candidate?.id, rule: 'Unload scene textures on exit.', acceptedBy: 'auto-accept' },
    ])
    const events = await store.audit.list({ action: 'learning.accept' })
    expect(events.events).toMatchObject([
      {
        actor: { id: 'auto-accept', provider: 'system' },
        target: { type: 'learning', id: candidate?.id, repo: 'work:games/a' },
        details: {
          auto: true,
          origin: 'mcp',
          scope: 'group:games',
          proposedBy: candidate?.proposal?.by,
        },
      },
    ])
  })

  test('a proposal of someone who may only read the repository stays proposed', async () => {
    await autoAccept({ sources: ['mcp'], scope: 'suggested' })
    const result = await propose('Unload scene textures on exit.', 'group:games', asReader)
    expect(result.content[0]?.text).toStartWith('Proposed ')
    expect((await store.learnings.list())[0]?.status).toBe('proposed')
    expect((await store.guides.list()).flatMap((row) => row.learnings)).toEqual([])
  })

  test('a repository entry never accepts into its group', async () => {
    await autoAccept({ sources: ['mcp'], scope: 'suggested' }, { repos: ['work:games/a'] })
    await propose('Preload scene audio.', 'group:games')
    expect((await store.learnings.list())[0]).toMatchObject({
      status: 'accepted',
      acceptedScope: 'repo:work:games/a',
    })
    expect((await store.guides.get('group:games', 'general'))?.learnings ?? []).toEqual([])
  })

  test('the repo option keeps auto-accepted rules in the repository', async () => {
    await autoAccept({ sources: ['mcp'], scope: 'repo' })
    await propose('Preload scene audio.', 'group')
    const [candidate] = await store.learnings.list()
    expect(candidate).toMatchObject({
      status: 'accepted',
      acceptedScope: 'repo:work:games/a',
      suggestedScope: 'group',
    })
    expect((await store.guides.get('group:games', 'general'))?.learnings ?? []).toEqual([])
  })

  test('the entry that applies to the repository decides', async () => {
    await autoAccept({ sources: ['mcp'], scope: 'suggested' })
    await autoAccept({ sources: [], scope: 'suggested' }, { groups: ['games'] })
    await propose('Bake scene lights.')
    expect((await store.learnings.list())[0]?.status).toBe('proposed')
  })
})

describe('evaluate_dependency', () => {
  beforeEach(async () => {
    const moment = {
      name: 'moment',
      versions: ['2.29.1'],
      ranges: ['^2.29.0'],
      workspaces: ['root'],
      count: 4,
      files: 3,
      exports: [],
    }
    await store.analyses.add({
      repo: { forge: 'work', path: 'games/a' },
      kind: 'usages',
      createdAt: '2026-10-20T00:00:00.000Z',
      data: { packages: [moment], files: 10, types: { status: 'used', projects: [], sites: 0 } },
    })
    await store.auditRuns.add({
      repo: { forge: 'work', path: 'games/a' },
      trigger: 'schedule',
      startedAt: '2026-10-20T00:00:00.000Z',
      finishedAt: '2026-10-20T00:01:00.000Z',
      report: {
        scanner: 'osv-scanner',
        findings: [
          {
            id: 'GHSA-wc69-rhjr-hc9g',
            aliases: ['CVE-2022-31129'],
            summary: 'Inefficient parsing of RFC 2822 dates',
            severity: 'high',
            url: 'https://osv.dev/GHSA-wc69-rhjr-hc9g',
            package: { name: 'moment', version: '2.29.1', ecosystem: 'npm' },
            source: 'package-lock.json',
            fixedVersions: ['2.29.4'],
          },
        ],
        ignored: [],
        expired: [],
        fixes: [],
        resolved: [],
        changedFiles: [],
      },
    })
    const policy = { allow: ['MIT'], deny: ['GPL-*'], ignore: [] }
    await store.analyses.add({
      repo: { forge: 'work', path: 'games/a' },
      kind: 'licenses',
      createdAt: '2026-10-20T00:00:00.000Z',
      data: {
        tool: { name: 'osv-scanner' },
        policy,
        packages: [
          {
            name: 'moment',
            version: '2.29.1',
            ecosystem: 'npm',
            sources: ['package-lock.json'],
            licenses: ['MIT'],
            verdict: 'allowed',
          },
        ],
      },
    })
    await store.analyses.add({
      repo: { forge: 'work', path: 'libs/ui' },
      kind: 'licenses',
      createdAt: '2026-10-20T00:00:00.000Z',
      data: { tool: { name: 'osv-scanner' }, policy: { ...policy, deny: ['MIT'] }, packages: [] },
    })
    await store.analyses.add({
      repo: { forge: 'work', path: 'games/a' },
      kind: 'bundle',
      createdAt: '2026-10-20T00:00:00.000Z',
      data: {
        assets: [
          {
            file: 'a.js',
            name: 'a.js',
            kind: 'js',
            raw: 4000,
            gzip: 1600,
            brotli: 1400,
            mapped: 4000,
          },
        ],
        entrypoints: [],
        packages: [
          {
            name: 'moment',
            bytes: 2000,
            gzip: 400,
            versions: ['2.29.1'],
            instances: ['node_modules/moment'],
            modules: 3,
            entrypoints: ['main'],
          },
        ],
        modules: [],
        unmapped: 0,
      },
    })
    await entry('dates', {
      title: 'Use date-fns instead of moment',
      packages: [{ ecosystem: 'npm', name: 'moment' }],
    })
  })

  test('joins uses, advisories, licenses, bundles and knowledge', async () => {
    const result = await callTool(
      'evaluate_dependency',
      { package: 'moment', version: '2.29.1', repo: 'work:libs/ui' },
      asAdmin,
    )
    const text = result.content[0]?.text ?? ''
    expect(text).toContain('  - `work:games/a`: 2.29.1; 4 uses in 3 files; team games')
    expect(text).toContain(
      '- high `GHSA-wc69-rhjr-hc9g` Inefficient parsing of RFC 2822 dates — **affects 2.29.1**, seen at 2.29.1 in `work:games/a`; fixed in 2.29.4',
    )
    expect(text).toContain('- 2.29.1: MIT — allowed in `work:games/a`')
    expect(text).toContain('- Under the license policy of `work:libs/ui`: denied (MIT).')
    expect(text).toContain('- `work:games/a` build `app`: 0.4 kB gzip (25.0% of 1.6 kB), 2.29.1')
    expect(text).toContain('[kb:dates] Use date-fns instead of moment')
  })

  test('advisories need audits:read', async () => {
    const result = await callTool('evaluate_dependency', { package: 'moment' }, asGames)
    const text = result.content[0]?.text ?? ''
    expect(text).toContain('No advisory in the newest audits of 0 repositories')
    expect(text).toContain('`work:games/a`: 2.29.1')
  })

  test('audits repo.analyzers turns off are left out', async () => {
    await store.settings.put({
      id: 'off',
      key: 'repo.analyzers',
      scope: { repos: ['work:games/a'] },
      value: { off: ['audit'] },
      secret: false,
      updatedAt: '2026-10-01T00:00:00.000Z',
    })
    const result = await callTool('evaluate_dependency', { package: 'moment' }, asAdmin)
    expect(result.content[0]?.text ?? '').toContain(
      'No advisory in the newest audits of 0 repositories',
    )
  })
})

describe('API catalog index', () => {
  test('rescans read the data of new records only', async () => {
    const reads: string[] = []
    const analyses = {
      ...store.analyses,
      get: async (id: string) => {
        reads.push(id)
        return store.analyses.get(id)
      },
      list: async () => {
        throw new Error('the catalog must not list records with their data')
      },
    }
    const catalog = createApiCatalog({ analyses, now: () => now.getTime() })
    expect((await catalog.packages(() => true)).map((pkg) => pkg.name)).toEqual([
      '@acme/ui',
      '@games/engine',
    ])
    expect(reads).toHaveLength(4)

    const added = await add(
      'games/b',
      { packages: [ui('2.0.0', ['tab'])] },
      '2026-10-02T00:00:00.000Z',
    )
    reads.length = 0
    await catalog.rescan()
    expect(reads).toEqual([added.id])
  })
})

describe('commit conventions', () => {
  test('combine the setting with history and check messages', async () => {
    await store.settings.put({
      id: 'conventions',
      key: 'commits.conventions',
      scope: { repos: ['work:games/a'] },
      value: { commit: { maxLength: 50 }, notes: 'Squash merge requests.' },
      secret: false,
      updatedAt: now.toISOString(),
    })
    const listed = await callTool('commit_conventions', { repo: 'work:games/a' }, asGames)
    const text = listed.content[0]?.text ?? ''
    expect(text).toContain('Template: `<type>(<scope>): [<TICKET>] <subject>`')
    expect(text).toContain('- Title at most 50 characters _(team setting)_')
    expect(text).toContain('`feat(scene): [GAME-0] add level 0`')
    expect(text).toContain('Squash merge requests.')

    const checked = await callTool(
      'check_commit_message',
      { repo: 'work:games/a', message: 'Add level', branch: 'levels' },
      asGames,
    )
    expect(checked.content[0]?.text).toContain('error: The branch name must match `^(feat|fix)/`')
    expect(checked.content[0]?.text).toContain('warning: The title must look like')

    expect((await callTool('commit_conventions', { repo: 'work:libs/ui' }, asGames)).isError).toBe(
      true,
    )
  })
})
