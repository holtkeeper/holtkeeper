import { beforeEach, describe, expect, test } from 'bun:test'

import type {
  CreateMcpTokenResult,
  McpTokenList,
  McpUsageOverview,
  PublicApiDiff,
  PublicApiPackageDetail,
  PublicApiPackageList,
  PublicApiSearchResult,
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
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import type { UsagesData } from '@holtkeeper/usages'
import { aesVault } from '@holtkeeper/vault'

import { createApiCatalog } from '../src/api-surface/catalog.ts'
import { createApp } from '../src/app.ts'

const config = parseConfig({
  forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => ({}) as never } },
  groups: {
    libs: { forge: 'work', include: ['libs/ui'] },
    games: { forge: 'work', include: ['games/a'] },
  },
})

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['*'] }],
    games: [{ scope: { groups: ['games'] }, actions: ['analyses:read', 'analyses:run'] }],
  },
})
const asAdmin = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'admin' }
const asGames = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'games' }

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
      activity: store.activity,
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

describe('catalog routes', () => {
  test('lists the newest version of each package the caller may read', async () => {
    const list = await get<PublicApiPackageList>('/api/api-surface/packages')
    expect(list.packages.map((p) => [p.name, p.version, p.exports, p.versions, p.ref])).toEqual([
      ['@acme/ui', '1.1.0', 3, 3, undefined],
      ['@games/engine', '0.1.0', 1, 1, undefined],
    ])
    expect(list.indexedAt).toBeDefined()
    const games = await get<PublicApiPackageList>('/api/api-surface/packages', asGames)
    expect(games.packages.map((p) => p.name)).toEqual(['@games/engine'])
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
    ])

    const packages = await callTool('list_packages', {}, bearer)
    expect(packages.content[0]?.text).toContain('**@games/engine**@0.1.0')
    expect(packages.content[0]?.text).not.toContain('@acme/ui')
    const hidden = await callTool('get_package_api', { package: '@acme/ui' }, bearer)
    expect(hidden.isError).toBe(true)

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
      '- `work:games/a` — 1.0.0, 3 uses in 2 files, 2 exports',
    )
    const found = await callTool('find_usages', { package: '@acme/ui', export: 'button' }, asAdmin)
    expect(found.content[0]?.text).toContain('`src/hud.tsx:9` — jsx props `variant`')
    const packages = await callTool('repo_packages', { repo: 'work:games/a' }, asAdmin)
    expect(packages.content[0]?.text).toContain(
      '- **@acme/ui** 1.0.0 — 3 uses in 2 files, 2 exports',
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
