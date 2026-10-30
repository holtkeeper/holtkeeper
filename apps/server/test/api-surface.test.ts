import { beforeEach, describe, expect, test } from 'bun:test'

import type {
  CreateMcpTokenResult,
  McpTokenList,
  McpUsageOverview,
  PublicApiDiff,
  PublicApiPackageDetail,
  PublicApiPackageList,
  PublicApiSearchResult,
} from '@holtkeeper/api'
import type { ApiPackage, ApiSurfaceData } from '@holtkeeper/api-surface'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

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
