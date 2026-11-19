import { beforeEach, describe, expect, test } from 'bun:test'

import type {
  CreateMcpTokenResult,
  GitHubTokenUsage,
  LibraryIndexStatus,
  LibraryReindexResult,
  PublicApiPackageSummary,
  RepoRef,
} from '@holtkeeper/api'
import type { ApiPackage } from '@holtkeeper/api-surface'
import { type ArtifactStore, memoryArtifactStore } from '@holtkeeper/artifacts'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { type DepEdge, type DepNode, analyzeLayer } from '@holtkeeper/depgraph'
import type { GitForge } from '@holtkeeper/forge'
import type { LibraryRegistry } from '@holtkeeper/libraries'
import { builtinSettings } from '@holtkeeper/settings'
import type { LibraryStore, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import type { UsagesData } from '@holtkeeper/usages'
import { aesVault } from '@holtkeeper/vault'

import { builtinAnalyses } from '../src/analyses.ts'
import { type ApiCatalog, createApiCatalog } from '../src/api-surface/catalog.ts'
import { createUsageIndex } from '../src/api-surface/usages.ts'
import { createApp } from '../src/app.ts'
import { githubUsageFor } from '../src/github-usage.ts'
import { goPrivatePatterns } from '../src/go-private.ts'
import {
  fleetLibraryUses,
  githubClientFor,
  librariesConfig,
  librariesConfigFrom,
  librariesSetting,
  lastLibraryRun,
  noteLibraryUses,
  ownPackageOf,
  ownPackageSource,
  requestLibraryIndex,
  runLibraryIndex,
  startLibraryIndex,
} from '../src/libraries.ts'
import { packagesToolset } from '../src/tools/packages.ts'
import { agentCatalogContext } from '../src/tools/registry.ts'

const config = parseConfig({
  forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => ({}) as never } },
  teams: {
    libs: { owns: ['work:libs/ui'] },
    games: { owns: ['work:games/a'] },
  },
})

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['*'] }],
    games: [{ scope: { teams: ['games'] }, actions: ['analyses:read', 'analyses:run'] }],
    outsider: [{ scope: { teams: ['nothing'] }, actions: ['analyses:read'] }],
  },
})
const asAdmin = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'admin' }
const asGames = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'games' }
const asOutsider = { 'x-forwarded-user': 'eve', 'x-forwarded-groups': 'outsider' }

const now = new Date('2026-10-30T12:00:00.000Z')
const at = now.toISOString()
const zod = { ecosystem: 'npm', name: 'zod' } as const
const left = { ecosystem: 'npm', name: 'left-pad' } as const
const repository = { host: 'example.com', path: 'colinhacks/zod', url: 'https://example.com/zod' }

const zodApi = (version: string, names: string[]): ApiPackage => ({
  name: 'zod',
  version,
  private: false,
  dir: '.',
  entries: [
    {
      subpath: '.',
      file: 'index.d.ts',
      symbols: names.map((name) => ({
        name,
        kind: 'function',
        signature: `declare function ${name}(): void`,
        doc: `Makes a ${name}.`,
        file: 'index.d.ts',
        line: 1,
      })),
    },
  ],
})

const usage = (name: string, version: string, exported: string): UsagesData => ({
  packages: [
    {
      name,
      versions: [version],
      ranges: [`^${version}`],
      workspaces: ['root'],
      count: 1,
      files: 1,
      exports: [
        {
          name: exported,
          subpath: '.',
          count: 1,
          files: 1,
          kinds: { call: 1 },
          members: [],
          props: [],
          spread: 0,
          sites: [
            {
              file: 'src/schema.ts',
              line: 3,
              column: 1,
              kind: 'call',
              snippet: `${exported}()`,
              snippetLine: 3,
            },
          ],
        },
      ],
    },
  ],
  files: 4,
  types: { status: 'used' },
})

let store: Store
let libraries: LibraryStore
let artifacts: ArtifactStore
let app: ReturnType<typeof createApp>

const enable = (value: unknown = { enabled: true }) =>
  store.settings.put({
    id: 'libraries-global',
    key: 'libraries',
    scope: { all: true },
    value,
    secret: false,
    updatedAt: at,
  })

const putApi = async (version: string, names: string[]) =>
  (
    await artifacts.put(new TextEncoder().encode(JSON.stringify([zodApi(version, names)])), {
      name: `npm/zod/${version}/api.json`,
    })
  ).id

const seed = async () => {
  await libraries.putLibrary({
    ...zod,
    description: 'Schemas',
    repository,
    latest: '4.0.0',
    sources: { registry: { status: 'ok', at }, issues: { status: 'failed', at, message: 'x' } },
    updatedAt: at,
  })
  await libraries.putVersion({
    ...zod,
    version: '3.22.0',
    roles: ['used'],
    usedBy: ['work:libs/ui', 'work:games/a'],
    api: await putApi('3.22.0', ['object', 'string', 'nativeEnum']),
    sources: { archive: { status: 'ok', at }, api: { status: 'ok', at } },
    updatedAt: at,
  })
  await libraries.putVersion({
    ...zod,
    version: '4.0.0',
    roles: ['latest', 'major'],
    usedBy: [],
    publishedAt: '2026-07-01T00:00:00.000Z',
    api: await putApi('4.0.0', ['object', 'string', 'enum']),
    sources: { archive: { status: 'ok', at }, api: { status: 'ok', at } },
    updatedAt: at,
  })
  const chunk = (version: string, text: string) => ({
    ...zod,
    id: `readme-${version}`,
    source: 'archive' as const,
    path: 'README.md',
    headings: ['zod', 'Refinements'],
    anchor: 'refinements',
    text,
    url: `https://unpkg.com/zod@${version}/README.md`,
  })
  await libraries.replaceChunks(zod, '3.22.0', 'archive', [
    chunk('3.22.0', 'Use superRefine for refinements in zod 3.'),
  ])
  await libraries.replaceChunks(zod, '4.0.0', 'archive', [
    chunk('4.0.0', 'Use check for refinements in zod 4.'),
  ])
  await libraries.putIssues([
    {
      ...zod,
      id: 'example.com/colinhacks/zod#42',
      number: 42,
      kind: 'issue',
      title: 'TypeError: schema.parse is not a function after upgrade',
      state: 'closed',
      labels: ['bug'],
      url: 'https://example.com/zod/issues/42',
      body: 'After upgrading, schema.parse is not a function.',
      pulls: [43],
      fixedIn: '4.0.1',
      reactions: 3,
      comments: 2,
      createdAt: '2026-07-02T00:00:00.000Z',
      updatedAt: '2026-07-03T00:00:00.000Z',
    },
  ])
  await libraries.putLibrary({ ...left, sources: {}, updatedAt: at })
  await libraries.replaceChunks(left, '1.3.0', 'archive', [
    {
      ...left,
      id: 'left-readme',
      source: 'archive',
      path: 'README.md',
      headings: ['left-pad'],
      text: 'Padding refinements on the left.',
    },
  ])
  await libraries.putVersion({
    ...left,
    version: '1.3.0',
    roles: ['used', 'latest'],
    usedBy: ['work:libs/ui'],
    sources: {},
    updatedAt: at,
  })
}

beforeEach(async () => {
  store = memoryStore()
  libraries = store.libraries as LibraryStore
  artifacts = memoryArtifactStore()
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
    settings: [...builtinSettings, librariesSetting],
    analyses: builtinAnalyses,
    artifacts,
    now: () => now,
  })
  await seed()
})

const get = async <T>(path: string, headers: Record<string, string> = asAdmin) => {
  const response = await app.request(path, { headers })
  expect(response.status).toBe(200)
  return (await response.json()) as T
}

describe('libraries setting', () => {
  test('applies defaults and rejects short intervals', () => {
    expect(librariesConfig(undefined)).toBeUndefined()
    const parsed = librariesConfig({ sources: { site: true }, interval: '12h' })
    expect(parsed?.index.enabled).toBe(true)
    expect(parsed?.index.sources).toEqual({
      repository: true,
      releases: true,
      issues: true,
      site: true,
    })
    expect(parsed?.intervalMs).toBe(43_200_000)
    expect(parsed?.digests).toBe(false)
    expect(librariesConfig({ interval: '30m' })).toBeUndefined()
  })

  test('indexes with the defaults without a stored value, and not with a broken one', () => {
    expect(librariesConfigFrom([])?.index.enabled).toBe(true)
    expect(
      librariesConfigFrom([
        {
          id: 'x',
          key: 'libraries',
          scope: { all: true },
          value: { interval: '1m' },
          secret: false,
          updatedAt: at,
        },
      ]),
    ).toBeUndefined()
  })

  test('reads github as a list of credential references, one string included', () => {
    expect(librariesConfig({})?.github).toBeUndefined()
    expect(librariesConfig({ github: [] })?.github).toEqual([])
    expect(librariesConfig({ github: 'gh-a' })?.github).toEqual(['gh-a'])
    expect(librariesConfig({ github: ['gh-a', 'gh-b', 'gh-a'] })?.github).toEqual(['gh-a', 'gh-b'])
    expect(librariesConfig({ github: [''] })).toBeUndefined()
  })
})

describe('githubClientFor', () => {
  const credentials = {
    list: async () => [
      { id: 'c1', name: 'org-a' },
      { id: 'c2', name: 'org-b' },
      { id: 'c3', name: 'broken' },
    ],
    reveal: async (id: string) => {
      if (id === 'c3') throw new Error('sealed with another key')
      return `token-${id}`
    },
  }

  test('pools the tokens of every readable reference and logs the rest', async () => {
    const lines: string[] = []
    const seen: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization') ?? ''
      if ((input instanceof Request ? input.url : input.toString()).endsWith('/user'))
        return new Response(
          JSON.stringify({ login: authorization.endsWith('c1') ? 'bot-a' : 'bot-b' }),
        )
      seen.push(authorization)
      return new Response('{}', {
        headers: { 'x-ratelimit-remaining': authorization.endsWith('c1') ? '1' : '100' },
      })
    }) as typeof fetch
    try {
      const client = await githubClientFor(credentials, ['org-a', 'c2', 'broken', 'missing'], {
        log: (line) => lines.push(line),
      })
      expect(client.authenticated).toBe(true)
      await client.rest('/repos/x/y')
      await client.rest('/repos/x/y')
      expect(seen).toEqual(['Bearer token-c1', 'Bearer token-c2'])
    } finally {
      globalThis.fetch = realFetch
    }
    expect(lines.join('\n')).toContain('"broken"')
    expect(lines.join('\n')).toContain('no credential "missing"')
  })

  test('is anonymous with an empty list', async () => {
    expect((await githubClientFor(credentials, [])).authenticated).toBe(false)
  })

  test('takes every github credential when the setting names none', async () => {
    const realFetch = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('authorization') ?? '')
      return new Response('{}')
    }) as typeof fetch
    try {
      const client = await githubClientFor(
        {
          list: async () => [
            { id: 'c1', name: 'gitlab-main', kind: 'gitlab' },
            { id: 'c2', name: 'github-libraries', kind: 'github' },
          ],
          reveal: async (id) => `token-${id}`,
        },
        undefined,
      )
      expect(client.authenticated).toBe(true)
      await client.rest('/repos/x/y')
    } finally {
      globalThis.fetch = realFetch
    }
    expect(seen).toEqual(['Bearer token-c2'])
  })
})

const post = (headers: Record<string, string>) =>
  app.request('/api/system/library-index/reindex', { method: 'POST', headers })

describe('library index admin routes', () => {
  test('lists every indexed library for global settings:read', async () => {
    await enable({ enabled: false })
    const status = await get<LibraryIndexStatus>('/api/system/library-index')
    expect(status.enabled).toBe(false)
    expect(
      status.libraries.map((l) => [l.name, l.versions, l.repos, l.chunks, l.issues, l.failed]),
    ).toEqual([
      ['left-pad', ['1.3.0'], 1, 1, 0, []],
      ['zod', ['4.0.0', '3.22.0'], 2, 2, 1, ['issues']],
    ])
    expect(status.libraries[1]?.repository).toBe('https://example.com/zod')
    expect((await app.request('/api/system/library-index', { headers: asGames })).status).toBe(403)

    await enable()
    const filtered = await get<LibraryIndexStatus>('/api/system/library-index?q=pad')
    expect(filtered.enabled).toBe(true)
    expect(filtered.libraries.map((l) => l.name)).toEqual(['left-pad'])
    expect(
      (await app.request('/api/system/library-index?ecosystem=rust', { headers: asAdmin })).status,
    ).toBe(400)
  })

  test('carries coverage per source and the running index run', async () => {
    const before = await get<LibraryIndexStatus>('/api/system/library-index')
    expect(before.progress).toBeUndefined()
    expect(before.coverage.map((row) => row.source)).toContain('archive')
    await store.kv?.set('libraries:progress', {
      startedAt: at,
      total: 4,
      done: 1,
      library: 'npm:zod',
      updatedAt: at,
    })
    expect((await get<LibraryIndexStatus>('/api/system/library-index')).progress).toMatchObject({
      total: 4,
      done: 1,
      library: 'npm:zod',
    })
  })

  test('the index is on without a libraries setting', async () => {
    expect((await get<LibraryIndexStatus>('/api/system/library-index')).enabled).toBe(true)
    expect((await post(asAdmin)).status).toBe(200)
  })

  test('reindex needs global analyses:run and the setting on', async () => {
    expect((await post(asGames)).status).toBe(403)
    await enable({ enabled: false })
    expect((await post(asAdmin)).status).toBe(409)
    await enable()
    const response = await post(asAdmin)
    expect(response.status).toBe(200)
    expect(((await response.json()) as LibraryReindexResult).started).toBe(true)
    expect(await store.kv?.get('libraries:reindex')).toBe(true)
  })

  test('GitHub token usage needs global settings:read and counts what the clients sent', async () => {
    expect(
      (await app.request('/api/system/library-index/github', { headers: asGames })).status,
    ).toBe(403)
    const counter = githubUsageFor(store.kv, () => now)
    counter.record({
      kind: 'request',
      resource: 'core',
      status: 200,
      notModified: false,
      limited: false,
    })
    counter.record({
      kind: 'request',
      resource: 'core',
      status: 304,
      notModified: true,
      limited: false,
    })
    counter.record({ kind: 'wait', resource: 'search', ms: 1500 })
    const body = await get<GitHubTokenUsage>('/api/system/library-index/github?days=7', asAdmin)
    expect(body.tokens).toEqual([])
    expect(body.days).toHaveLength(7)
    expect(body.anonymous['core']).toMatchObject({ requests: 2, notModified: 1 })
    expect(body.totals).toMatchObject({ requests: 2, notModified: 1, waits: 1, waitMs: 1500 })
    expect(body.days.at(-1)?.byToken).toEqual({ anonymous: 2 })
  })

  test('MCP tokens cannot reach the admin routes', async () => {
    const created = await app.request('/api/api-surface/mcp/tokens', {
      method: 'POST',
      headers: { ...asAdmin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'cli' }),
    })
    const { secret } = (await created.json()) as CreateMcpTokenResult
    const bearer = { authorization: `Bearer ${secret}` }
    expect((await app.request('/api/system/library-index', { headers: bearer })).status).toBe(401)
    expect(
      (await app.request('/api/system/library-index/reindex', { method: 'POST', headers: bearer }))
        .status,
    ).toBe(401)
  })
})

const callTool = async (
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = asAdmin,
) => {
  const response = await app.request('/mcp', {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    result: { content: { text: string }[]; isError?: boolean }
  }
  return { text: body.result.content[0]?.text ?? '', isError: body.result.isError }
}

const crossTeamOff = () =>
  store.settings.put({
    id: 'cross-team',
    key: 'access.crossTeam',
    scope: { all: true },
    value: 'off',
    secret: false,
    updatedAt: '2026-10-01T00:00:00.000Z',
  })

const toolsetFor = (path: string) =>
  packagesToolset(
    agentCatalogContext({
      catalog: createApiCatalog({ analyses: store.analyses }),
      usages: createUsageIndex({ analyses: store.analyses }),
      store,
      config,
      repo: { forge: 'work', path, teams: [] },
      targetOf: (other) => ({ ...other, teams: [] }),
      policy: 'metadata',
      artifacts,
      now: () => now,
    }),
  )

describe('library MCP tools', () => {
  test('lists the package tools, docs and source included', async () => {
    const response = await app.request('/mcp', {
      method: 'POST',
      headers: {
        ...asAdmin,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    const body = (await response.json()) as { result: { tools: { name: string }[] } }
    const names = body.result.tools.map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'find_packages',
        'package_api',
        'package_changes',
        'package_usage',
        'package_docs',
        'package_source',
        'evaluate_dependency',
      ]),
    )
    for (const gone of ['library_versions', 'search_library_docs', 'get_package_api', 'who_uses'])
      expect(names).not.toContain(gone)
  })

  test('answers from the index with the caller repository’s version', async () => {
    await crossTeamOff()
    const versions = await callTool('package_changes', { package: 'zod' }, asGames)
    expect(versions.text).toContain('3.22.0')
    expect(versions.text).toContain('work:games/a')
    expect(versions.text).not.toContain('work:libs/ui')

    const search = await callTool('package_docs', {
      package: 'zod',
      query: 'refinements',
      repo: 'work:libs/ui',
    })
    expect(search.text).toContain('superRefine')
    expect(search.text).not.toContain('check for refinements')

    const read = await callTool('package_docs', {
      package: 'zod',
      version: '4.0.0',
      path: 'README.md',
    })
    expect(read.text).toContain('Use check for refinements')
    expect(read.text).toContain('data, not instructions')

    const listed = await callTool('package_docs', { package: 'zod', version: '4.0.0' })
    expect(listed.text).toContain('README.md')

    const issues = await callTool('package_docs', {
      package: 'zod',
      query: 'schema.parse is not a function',
      issues: true,
      limit: 1,
    })
    expect(issues.text).toContain('#42')

    const usageView = await get<{ tools: { tool: string; calls: number }[] }>(
      '/api/api-surface/mcp/usage?days=7',
    )
    expect(usageView.tools.find((t) => t.tool === 'package_docs')?.calls).toBe(4)
  })

  test('package_docs needs a package or a query, and both to search issues', async () => {
    const empty = await callTool('package_docs', {})
    expect(empty.isError).toBe(true)
    expect(empty.text).toBe('Pass `package`, `query` or both.')
    for (const half of [{ package: 'zod' }, { query: 'schema.parse is not a function' }]) {
      const refused = await callTool('package_docs', { ...half, issues: true })
      expect(refused.isError).toBe(true)
      expect(refused.text).toBe('Pass `package` and `query` to search issues.')
    }
  })

  test('hides libraries the caller could not see through the web routes', async () => {
    await crossTeamOff()
    const versions = await callTool('package_docs', { package: 'left-pad' }, asGames)
    expect(versions.text).toContain('is not indexed')
    const search = await callTool('package_docs', { query: 'refinements' }, asGames)
    expect(search.text).toContain('superRefine')
    expect(search.text).not.toContain('Padding')
    const all = await callTool('package_docs', { query: 'refinements' })
    expect(all.text).toContain('Padding')

    const found = await callTool('find_packages', { query: 'pad' }, asGames)
    expect(found.text).not.toContain('left-pad')
    expect((await callTool('find_packages', { query: 'pad' })).text).toContain(
      '## Third-party libraries\n- **left-pad** (npm)',
    )

    const hidden = await callTool('package_docs', { package: 'zod' }, asOutsider)
    expect(hidden.text).toContain('is not indexed')
    const issues = await callTool(
      'package_docs',
      { package: 'zod', query: 'schema.parse is not a function', issues: true },
      asOutsider,
    )
    expect(issues.text).not.toContain('#42')
    const api = await callTool('package_api', { package: 'zod' }, asOutsider)
    expect(api.isError).toBe(true)
    expect(api.text).toContain('No package zod')
    const changes = await callTool('package_changes', { package: 'zod' }, asOutsider)
    expect(changes.isError).toBe(true)
    expect(
      (
        await app.request('/api/dependencies/library?ecosystem=npm&name=zod', {
          headers: asOutsider,
        })
      ).status,
    ).toBe(404)
  })

  test('a package of the organization is answered by the same tools, without indexed docs', async () => {
    await store.analyses.add({
      repo: { forge: 'work', path: 'libs/ui' },
      kind: 'api-surface',
      createdAt: at,
      data: { packages: [{ ...zodApi('2.0.0', ['RoundWidget']), name: '@acme/widgets' }] },
    })
    const deep = await callTool('package_docs', {
      package: '@acme/widgets/lib/round/RoundWidget',
    })
    expect(deep.text).toContain('belongs to @acme/widgets, which is a package of this organization')
    expect(deep.text).toContain('package_api @acme/widgets')
    const api = await callTool('package_api', { package: '@acme/widgets/lib/round' })
    expect(api.text).toContain('@acme/widgets/lib/round is a deep import into @acme/widgets')
    const own = await callTool('package_api', { package: '@acme/widgets', symbol: 'RoundWidget' })
    expect(own.text).toContain("import { RoundWidget } from '@acme/widgets'")
    const versions = await callTool('package_changes', { package: '@acme/widgets' })
    expect(versions.text).toContain('# @acme/widgets in `work:libs/ui` (organization package)')
    const found = await callTool('find_packages', { query: 'widget' })
    expect(found.text).toContain('## Organization packages\n- **@acme/widgets**@2.0.0')
    expect(found.text).toContain('## Exports of organization packages')
    expect(found.text).toContain('RoundWidget (function)')
    const stranger = await callTool('package_docs', { package: '@acme/gadgets' })
    expect(stranger.text).toContain('is not indexed')
  })

  test('package_api reads a third-party API, one symbol of it and searches its exports', async () => {
    const api = await callTool('package_api', { package: 'zod', repo: 'work:libs/ui' })
    expect(api.isError).toBeUndefined()
    expect(api.text).toContain('zod@3.22.0')
    expect(api.text).toStartWith('Third-party content from zod@3.22.0')
    expect(api.text).toContain('nativeEnum')
    expect(api.text).toContain('Other indexed versions: 4.0.0')

    const symbol = await callTool('package_api', {
      package: 'zod',
      symbol: 'nativeEnum',
      repo: 'work:libs/ui',
    })
    expect(symbol.text).toContain('zod@3.22.0 (npm, third-party')
    expect(symbol.text).toContain("import { nativeEnum } from 'zod'")
    expect(symbol.text).toContain('Makes a nativeEnum.')
    expect(symbol.text).not.toContain('declare function object')

    const latest = await callTool('package_api', { package: 'zod', symbol: 'nativeEnum' })
    expect(latest.isError).toBe(true)
    expect(latest.text).toContain('zod@4.0.0 exports no nativeEnum')

    const search = await callTool('package_api', { package: 'zod', query: 'enum' })
    expect(search.text).toContain('### `zod` → enum (function)')
    expect(search.text).toContain('zod@4.0.0')
    expect(search.text).not.toContain('→ object')
    expect((await callTool('package_api', { package: 'zod', query: 'gadget' })).text).toBe(
      'zod@4.0.0 exports nothing matching "gadget".',
    )
    expect(
      (await callTool('package_api', { package: 'zod', query: 'enum', kind: 'class' })).text,
    ).toBe('zod@4.0.0 exports nothing matching "enum".')

    const missing = await callTool('package_api', { package: 'zod', version: '9.9.9' })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('indexed: 4.0.0, 3.22.0')
  })

  test('package_changes lists versions, and between two joins the API diff, notes and impact', async () => {
    const list = await callTool('package_changes', { package: 'zod' })
    expect(list.text).toContain('# zod (npm, third-party; versions with an indexed API)')
    expect(list.text).toContain('4.0.0 (latest, major)')
    expect(list.text).toContain('since 3.22.0: 1 removed, 0 changed, 1 added')
    expect(list.text).toContain('work:libs/ui')

    await store.analyses.add({
      repo: { forge: 'work', path: 'games/a' },
      kind: 'usages',
      createdAt: at,
      data: usage('zod', '3.22.0', 'nativeEnum'),
    })
    const changes = await callTool('package_changes', { package: 'zod', to: '4.0.0' })
    expect(changes.isError).toBeUndefined()
    expect(changes.text).toStartWith('zod 3.22.0 → 4.0.0 (npm, third-party)')
    expect(changes.text).toContain('nativeEnum')
    const notes = changes.text.indexOf('## Changelog and migration notes')
    const impact = changes.text.indexOf('## Uses the upgrade affects')
    expect(notes).toBeGreaterThan(0)
    expect(impact).toBeGreaterThan(notes)
    expect(changes.text.slice(impact)).toContain('nativeEnum()')

    const same = await callTool('package_changes', { package: 'zod', from: '3.22.0' })
    expect(same.text).toStartWith('zod 3.22.0 → 4.0.0 (npm, third-party)')

    const impactOnly = await callTool('package_changes', {
      package: 'zod',
      to: '4.0.0',
      include: ['impact'],
    })
    expect(impactOnly.text).toContain('nativeEnum()')
    expect(impactOnly.text).not.toContain('## Changelog and migration notes')
    expect(impactOnly.text).not.toContain('API from the published packages')
    const apiOnly = await callTool('package_changes', {
      package: 'zod',
      to: '4.0.0',
      include: ['api'],
    })
    expect(apiOnly.text).toContain('API from the published packages')
    expect(apiOnly.text).not.toContain('## Uses the upgrade affects')
  })

  test('package_usage sums who uses a package and returns the code on request', async () => {
    await store.analyses.add({
      repo: { forge: 'work', path: 'games/a' },
      kind: 'usages',
      createdAt: at,
      data: usage('zod', '3.22.0', 'nativeEnum'),
    })
    const summary = await callTool('package_usage', { package: 'zod' })
    expect(summary.text).toContain('work:games/a')
    expect(summary.text).toContain('nativeEnum')
    expect(summary.text).not.toContain('src/schema.ts')
    for (const narrowed of [{ code: true }, { export: 'nativeEnum' }, { repo: 'work:games/a' }]) {
      const code = await callTool('package_usage', { package: 'zod', ...narrowed })
      expect(code.text).toContain('src/schema.ts')
      expect(code.text).toContain('nativeEnum()')
    }
    const none = await callTool('package_usage', { package: 'zod', export: 'object' })
    expect(none.text).not.toContain('src/schema.ts')
    const stranger = await callTool('package_usage', { package: 'zod', repo: 'work:libs/none' })
    expect(stranger.isError).toBe(true)

    const imports = await callTool('find_packages', { repo: 'work:games/a' })
    expect(imports.text).toStartWith('# `work:games/a`: 1 packages')
    expect(imports.text).toContain('- **zod** 3.22.0 — 1 uses in 1 files, 1 exports')
    expect((await callTool('find_packages', { repo: 'work:libs/none' })).isError).toBe(true)
  })

  test('an agent’s own repository picks the version when a call names none', async () => {
    const ctx = { dir: '.', signal: new AbortController().signal }
    const api = (toolset: ReturnType<typeof toolsetFor>, input: Record<string, unknown>) =>
      toolset.tools.find((tool) => tool.name === 'package_api')!.run(input, ctx)
    expect(await api(toolsetFor('libs/ui'), { package: 'zod' })).toContain('zod@3.22.0')
    expect(await api(toolsetFor('libs/other'), { package: 'zod' })).toContain('zod@4.0.0')
    expect(await api(toolsetFor('libs/ui'), { package: 'zod', version: '4.0.0' })).toContain(
      'zod@4.0.0',
    )
    expect(toolsetFor('libs/ui').tools.map((tool) => tool.name)).not.toContain('package_docs')
  })

  test('an organization package resolves when repo is the repository that uses it', async () => {
    await store.analyses.add({
      repo: { forge: 'work', path: 'libs/ui' },
      kind: 'api-surface',
      createdAt: at,
      data: { packages: [{ ...zodApi('2.0.0', ['RoundWidget']), name: '@acme/widgets' }] },
    })
    const api = await callTool('package_api', { package: '@acme/widgets', repo: 'work:games/a' })
    expect(api.isError).toBeUndefined()
    expect(api.text).toContain('# @acme/widgets@2.0.0')
    expect(api.text).toContain('Repository: `work:libs/ui`')
    const versions = await callTool('package_changes', {
      package: '@acme/widgets',
      repo: 'work:games/a',
    })
    expect(versions.text).toContain('# @acme/widgets in `work:libs/ui` (organization package)')
  })

  test('package_changes targets the newest release and starts from what the repository uses', async () => {
    await libraries.putVersion({
      ...zod,
      version: '3.23.0',
      roles: [],
      usedBy: [],
      api: await putApi('3.23.0', ['object', 'string', 'nativeEnum']),
      sources: { archive: { status: 'ok', at }, api: { status: 'ok', at } },
      updatedAt: at,
    })
    const header = 'zod 3.22.0 → 4.0.0 (npm, third-party)'
    const fromOnly = await callTool('package_changes', {
      package: 'zod',
      from: '3.22.0',
      repo: 'work:libs/ui',
    })
    expect(fromOnly.text).toStartWith(header)
    expect(fromOnly.text).not.toContain('must be lower than')
    const ctx = { dir: '.', signal: new AbortController().signal }
    const changes = toolsetFor('libs/ui').tools.find((tool) => tool.name === 'package_changes')!
    expect(await changes.run({ package: 'zod', from: '3.22.0' }, ctx)).toStartWith(header)

    const used = await callTool('package_changes', {
      package: 'zod',
      to: '4.0.0',
      repo: 'work:libs/ui',
    })
    expect(used.text).toStartWith(header)
    const previous = await callTool('package_changes', { package: 'zod', to: '4.0.0' })
    expect(previous.text).toStartWith('zod 3.23.0 → 4.0.0 (npm, third-party)')
  })

  test('package_changes narrows the uses only to a repo the caller names, not to an agent own repository', async () => {
    for (const path of ['games/a', 'libs/ui'])
      // oxlint-disable-next-line no-await-in-loop -- fixtures in order
      await store.analyses.add({
        repo: { forge: 'work', path },
        kind: 'usages',
        createdAt: at,
        data: usage('zod', '3.22.0', 'nativeEnum'),
      })
    const changes = packagesToolset(
      agentCatalogContext({
        catalog: createApiCatalog({ analyses: store.analyses }),
        usages: createUsageIndex({ analyses: store.analyses }),
        store,
        config,
        repo: { forge: 'work', path: 'games/a', teams: [] },
        targetOf: (other) => ({ ...other, teams: [] }),
        policy: 'snippets',
        artifacts,
        now: () => now,
      }),
    ).tools.find((tool) => tool.name === 'package_changes')!
    const ctx = { dir: '.', signal: new AbortController().signal }
    const args = { package: 'zod', from: '3.22.0', to: '4.0.0', include: ['impact'] }
    const fleet = await changes.run(args, ctx)
    expect(fleet).toContain('`work:games/a`')
    expect(fleet).toContain('`work:libs/ui`')
    expect(fleet).not.toContain('affected too')
    const narrowed = await changes.run({ ...args, repo: 'work:games/a' }, ctx)
    expect(narrowed).toContain('`work:games/a`')
    expect(narrowed).not.toContain('`work:libs/ui`')
    expect(narrowed).toEndWith(
      "1 other repository is affected too; call with `from: '3.22.0'`, `to: '4.0.0'` and without `repo` for all of them.",
    )
  })

  test('an oversized third-party API part is cut inside its data fence with the note after it', async () => {
    const names = Array.from({ length: 400 }, (_, i) => `widgetSchema${String(i).padStart(4, '0')}`)
    await libraries.putVersion({
      ...zod,
      version: '5.0.0',
      roles: [],
      usedBy: [],
      api: await putApi('5.0.0', names),
      sources: { archive: { status: 'ok', at }, api: { status: 'ok', at } },
      updatedAt: at,
    })
    const { text } = await callTool('package_changes', {
      package: 'zod',
      from: '4.0.0',
      to: '5.0.0',
    })
    const note = text.indexOf("pass `include: ['api']` for all of it")
    expect(note).toBeGreaterThan(0)
    const opened = text.indexOf('Third-party content from zod 4.0.0 → 5.0.0')
    expect(opened).toBeGreaterThanOrEqual(0)
    const fenced = text.slice(opened, note)
    const fences = fenced.split('\n').filter((line) => /^`{3,}/.test(line))
    expect(fences.length % 2).toBe(0)
    expect(fences.at(-1)?.trim()).toMatch(/^`{3,}$/)
    expect(text).not.toContain('widgetSchema0399')
  })

  test('find_packages searches the same with and without repo', async () => {
    await store.analyses.add({
      repo: { forge: 'work', path: 'libs/ui' },
      kind: 'api-surface',
      createdAt: at,
      data: { packages: [{ ...zodApi('2.0.0', ['RoundWidget']), name: '@acme/widgets' }] },
    })
    for (const query of ['zod', 'widget']) {
      const plain = await callTool('find_packages', { query })
      const narrowed = await callTool('find_packages', { query, repo: 'work:games/a' })
      expect(narrowed.text).toBe(plain.text)
    }
    const zodHits = await callTool('find_packages', { query: 'zod', repo: 'work:games/a' })
    expect(zodHits.text).toContain('## Third-party libraries\n- **zod** (npm)')
    const widgetHits = await callTool('find_packages', { query: 'widget', repo: 'work:games/a' })
    expect(widgetHits.text).toContain('## Organization packages\n- **@acme/widgets**@2.0.0')
  })

  test('package_changes still gives the changelog when a version has no indexed API', async () => {
    const noApi = await callTool('package_changes', {
      package: 'left-pad',
      from: '1.0.0',
      to: '1.3.0',
    })
    expect(noApi.isError).toBeUndefined()
    expect(noApi.text).toStartWith('left-pad 1.0.0 → 1.3.0 (npm, third-party)')
    expect(noApi.text).toContain('No API diff or upgrade impact:')
    expect(noApi.text).toContain('# Changes of left-pad in (1.0.0, 1.3.0]')

    const oneMissing = await callTool('package_changes', {
      package: 'zod',
      from: '3.20.0',
      to: '4.0.0',
      include: ['notes'],
    })
    expect(oneMissing.isError).toBeUndefined()
    expect(oneMissing.text).toContain(
      'No API diff or upgrade impact: zod@3.20.0 has no indexed API',
    )
    expect(oneMissing.text).toContain('# Changes of zod in (3.20.0, 4.0.0]')

    const apiOnly = await callTool('package_changes', {
      package: 'zod',
      from: '3.20.0',
      to: '4.0.0',
      include: ['api'],
    })
    expect(apiOnly.isError).toBe(true)
    const unknown = await callTool('package_changes', {
      package: 'no-such-lib',
      from: '1.0.0',
      to: '2.0.0',
    })
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toContain('No package no-such-lib is indexed')
  })

  test('Go library API tools take module and package paths and pair packages across majors', async () => {
    const kit = { ecosystem: 'Go', name: 'example.com/acme/kit' } as const
    await libraries.putLibrary({ ...kit, latest: 'v2.0.0', sources: {}, updatedAt: at })
    await libraries.putVersion({
      ...kit,
      version: 'v1.5.0',
      roles: ['used'],
      usedBy: ['work:games/a'],
      api: await putGoApi('v1.5.0', [
        goPackage('example.com/acme/kit', '.', ['Run']),
        goPackage('example.com/acme/kit', 'draw', ['Line', 'Dot']),
      ]),
      sources: {},
      updatedAt: at,
    })
    await libraries.putVersion({
      ...kit,
      version: 'v2.0.0',
      roles: ['latest', 'major'],
      usedBy: [],
      api: await putGoApi('v2.0.0', [
        goPackage('example.com/acme/kit/v2', '.', ['Run']),
        goPackage('example.com/acme/kit/v2', 'draw', ['Line']),
      ]),
      sources: {},
      updatedAt: at,
    })

    const api = await callTool('package_api', { package: 'example.com/acme/kit/v2/draw' })
    expect(api.isError).toBeUndefined()
    expect(api.text).toContain('example.com/acme/kit@v2.0.0')
    expect(api.text).toContain('func Line()')
    expect(api.text).not.toContain('func Run()')

    const symbol = await callTool('package_api', {
      package: 'example.com/acme/kit/v2/draw',
      symbol: 'Line',
    })
    expect(symbol.text).toContain('import "example.com/acme/kit/v2/draw"')
    expect(symbol.text).toContain('// draw.Line')

    const diff = await callTool('package_changes', {
      package: 'example.com/acme/kit',
      to: 'v2.0.0',
      include: ['api'],
    })
    expect(diff.text).toContain('v1.5.0 → v2.0.0')
    expect(diff.text).toContain('Dot')
    expect(diff.text).not.toContain('Run')

    const missing = await callTool('package_api', { package: 'example.com/acme/kit/v2/paint' })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('has no package example.com/acme/kit/v2/paint')

    const evaluated = await callTool('evaluate_dependency', {
      package: 'example.com/acme/kit/v2',
      version: '1.5.0',
    })
    expect(evaluated.text).toContain('# example.com/acme/kit/v2@1.5.0 (Go)')
    expect(evaluated.text).toContain('Newest release v2.0.0')
  })
})

const goPackage = (module: string, dir: string, names: string[]): ApiPackage => ({
  name: dir === '.' ? module : `${module}/${dir}`,
  private: false,
  dir,
  ecosystem: 'Go',
  module,
  entries: [
    {
      subpath: '.',
      file: 'kit.go',
      symbols: names.map((name) => ({
        name,
        kind: 'function',
        signature: `func ${name}()`,
        file: 'kit.go',
        line: 1,
      })),
    },
  ],
})
const putGoApi = async (version: string, packages: ApiPackage[]) =>
  (
    await artifacts.put(new TextEncoder().encode(JSON.stringify(packages)), {
      name: `Go/kit/${version}/api.json`,
    })
  ).id

const goUsed = (name: string, version: string) =>
  usage(name, version, 'Draw').packages.map((pkg) =>
    Object.assign(pkg, { ecosystem: 'Go' as const }),
  )

const registry = (): LibraryRegistry => ({
  async library(ref) {
    if (ref.name !== 'tiny') return undefined
    return {
      ...ref,
      description: 'Tiny',
      latest: '1.1.0',
      versions: [
        { version: '1.0.0', publishedAt: '2026-01-01T00:00:00.000Z' },
        { version: '1.1.0', publishedAt: '2026-02-01T00:00:00.000Z' },
      ],
    }
  },
  async archive(_ref, version) {
    const encoder = new TextEncoder()
    return new Map([
      ['package.json', encoder.encode(JSON.stringify({ name: 'tiny', version }))],
      ['README.md', encoder.encode(`# tiny\n\nVersion ${version}.`)],
    ])
  },
})

const wait = async (check: () => boolean) => {
  // oxlint-disable-next-line no-await-in-loop -- polls until the condition holds
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5)
}

const indexDeps = () => ({
  store,
  artifacts,
  credentials: { list: async () => [], reveal: async () => '' },
  now: () => now,
})

const layer = (nodes: DepNode[], edges: DepEdge[]) =>
  analyzeLayer({ id: 'packages', source: 'test', graph: { nodes, edges } })

describe('library index triggers', () => {
  test('new usages and depgraph records ask for a debounced run', async () => {
    const kv = store.kv as NonNullable<Store['kv']>
    await noteLibraryUses(kv, 'stack', now)
    expect(await kv.get('libraries:reindex')).toBeUndefined()
    await noteLibraryUses(kv, 'usages', now)
    expect(await kv.get('libraries:reindex')).toEqual({ after: '2026-10-30T12:10:00.000Z' })
    await noteLibraryUses(kv, 'depgraph', new Date('2026-10-30T12:05:00.000Z'))
    expect(await kv.get('libraries:reindex')).toEqual({ after: '2026-10-30T12:15:00.000Z' })
    await requestLibraryIndex(kv)
    await noteLibraryUses(kv, 'usages', now)
    expect(await kv.get('libraries:reindex')).toBe(true)
  })

  test('ingesting a usages record notes it', async () => {
    const response = await app.request('/api/analyses', {
      method: 'POST',
      headers: { ...asAdmin, 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: { forge: 'work', path: 'libs/ui' },
        kind: 'usages',
        data: usage('zod', '3.22.0', 'object'),
      }),
    })
    expect(response.status).toBe(201)
    expect(await store.kv?.get('libraries:reindex')).toEqual({ after: '2026-10-30T12:10:00.000Z' })
  })
})

describe('library index duty', () => {
  beforeEach(async () => {
    await store.analyses.add({
      repo: { forge: 'work', path: 'libs/ui' },
      kind: 'usages',
      createdAt: at,
      data: usage('tiny', '1.0.0', 'tiny'),
    })
  })

  test('collects uses from depgraph and usages records, Go included, and finds internal packages', async () => {
    await store.analyses.add({
      repo: { forge: 'work', path: 'games/a' },
      kind: 'depgraph',
      createdAt: at,
      data: {
        layers: [
          layer(
            [
              {
                id: 'example.com/games/a',
                name: 'example.com/games/a',
                ecosystem: 'Go',
                kind: 'workspace',
              },
              {
                id: 's@v2.1.0',
                name: 'example.com/shapes/v2',
                version: 'v2.1.0',
                ecosystem: 'Go',
                kind: 'package',
              },
              {
                id: 'e@v0.3.0',
                name: 'example.com/games/engine',
                version: 'v0.3.0',
                ecosystem: 'Go',
                kind: 'package',
              },
            ],
            [
              { from: 'example.com/games/a', to: 's@v2.1.0', kind: 'prod' },
              { from: 'example.com/games/a', to: 'e@v0.3.0', kind: 'prod' },
            ],
          ),
        ],
        errors: [],
      },
    })
    await store.analyses.add({
      repo: { forge: 'work', path: 'games/engine' },
      kind: 'depgraph',
      createdAt: at,
      data: {
        layers: [
          layer(
            [{ id: 'm', name: 'example.com/games/engine', ecosystem: 'Go', kind: 'workspace' }],
            [],
          ),
          layer(
            [
              {
                id: 'kit',
                name: '@games/widget-kit',
                version: '2.0.0',
                ecosystem: 'npm',
                kind: 'workspace',
              },
              {
                id: 'tiny@1.0.0',
                name: 'tiny',
                version: '1.0.0',
                ecosystem: 'npm',
                kind: 'package',
              },
              { id: 'range', name: 'loose', version: '^1.0.0', ecosystem: 'npm', kind: 'package' },
            ],
            [
              { from: 'kit', to: 'tiny@1.0.0', kind: 'prod' },
              { from: 'kit', to: 'range', kind: 'prod' },
            ],
          ),
        ],
        errors: [],
      },
    })
    const { uses, internal, defined } = await fleetLibraryUses(store.analyses)
    expect(
      uses.toSorted((a, b) => `${a.repo}${a.name}`.localeCompare(`${b.repo}${b.name}`)),
    ).toEqual([
      {
        ecosystem: 'Go',
        name: 'example.com/games/engine',
        version: 'v0.3.0',
        repo: 'work:games/a',
      },
      { ecosystem: 'Go', name: 'example.com/shapes/v2', version: 'v2.1.0', repo: 'work:games/a' },
      { ecosystem: 'npm', name: 'tiny', version: '1.0.0', repo: 'work:games/engine' },
      { ecosystem: 'npm', name: 'tiny', version: '1.0.0', repo: 'work:libs/ui' },
    ])
    expect([...internal].toSorted()).toEqual([
      'Go:example.com/games/a',
      'Go:example.com/games/engine',
      'npm:@games/widget-kit',
    ])
    expect(Object.fromEntries(defined)).toEqual({
      'Go:example.com/games/engine': 'v0.3.0',
      'npm:@games/widget-kit': '2.0.0',
    })

    const games = await fleetLibraryUses(store.analyses, {
      accept: (repo) => repo.path === 'games/a',
    })
    expect(games.uses.map((use) => use.repo)).toEqual(['work:games/a', 'work:games/a'])
    expect(games.internal).toEqual(internal)
  })

  test('tags Go usages and Go catalog packages as Go, not npm', async () => {
    const goUsage = (name: string, version: string, local?: boolean) =>
      usage(name, version, 'Draw').packages.map((pkg) => ({
        ...pkg,
        ecosystem: 'Go' as const,
        ...(local ? { local } : {}),
      }))
    const data: UsagesData = {
      packages: [
        ...goUsage('example.com/acme/widgets/v2', 'v2.3.0'),
        ...goUsage('example.com/games/a/tools', 'v0.0.0', true),
        ...goUsage('example.com/net', 'v1.0.0', true).map((pkg) => ({
          ...pkg,
          replaced: true as const,
        })),
        ...usage('tiny', '1.0.0', 'x').packages,
      ],
      files: 2,
      types: { status: 'skipped', reason: 'go: syntactic only' },
    }
    await store.analyses.add({
      repo: { forge: 'work', path: 'games/a' },
      kind: 'usages',
      createdAt: at,
      data,
    })
    await store.analyses.add({
      repo: { forge: 'work', path: 'libs/geom' },
      kind: 'api-surface',
      createdAt: at,
      data: {
        packages: [
          {
            name: 'gitlab.example/shapes/geom/v3/circle',
            private: false,
            dir: 'circle',
            ecosystem: 'Go',
            module: 'gitlab.example/shapes/geom/v3',
            entries: [{ subpath: '.', symbols: [] }],
          },
        ],
      },
    })
    const { uses, internal } = await fleetLibraryUses(store.analyses)
    expect(
      uses
        .filter((use) => use.repo === 'work:games/a')
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    ).toEqual([
      {
        ecosystem: 'Go',
        name: 'example.com/acme/widgets/v2',
        version: 'v2.3.0',
        repo: 'work:games/a',
      },
      { ecosystem: 'npm', name: 'tiny', version: '1.0.0', repo: 'work:games/a' },
    ])
    expect([...internal].toSorted()).toEqual([
      'Go:example.com/games/a/tools',
      'Go:gitlab.example/shapes/geom',
      'Go:gitlab.example/shapes/geom/v3',
    ])
  })

  test('Go uses come from imported modules even without a depgraph, deduplicated with it', async () => {
    await store.analyses.add({
      repo: { forge: 'work', path: 'games/a' },
      kind: 'usages',
      createdAt: at,
      data: {
        packages: [
          ...goUsed('example.com/acme/pgdriver/v5', 'v5.2.0'),
          ...goUsed('example.com/acme/assert', 'v1.9.0'),
        ],
        files: 2,
        types: { status: 'skipped', reason: 'go: syntactic only' },
      },
    })
    await store.analyses.add({
      repo: { forge: 'work', path: 'games/a' },
      kind: 'depgraph',
      createdAt: at,
      data: {
        layers: [
          layer(
            [
              { id: 'a', name: 'example.com/games/a', ecosystem: 'Go', kind: 'workspace' },
              {
                id: 'pg',
                name: 'example.com/acme/pgdriver/v5',
                version: 'v5.2.0',
                ecosystem: 'Go',
                kind: 'package',
              },
            ],
            [{ from: 'a', to: 'pg', kind: 'prod' }],
          ),
        ],
        errors: [],
      },
    })
    const { uses } = await fleetLibraryUses(store.analyses)
    expect(
      uses
        .filter((use) => use.ecosystem === 'Go')
        .map((use) => `${use.name}@${use.version}`)
        .toSorted(),
    ).toEqual(['example.com/acme/assert@v1.9.0', 'example.com/acme/pgdriver/v5@v5.2.0'])
  })

  test('private Go module patterns: whole hosts of self-hosted forges, top groups on public hosts', () => {
    expect(
      goPrivatePatterns(
        [
          { id: 'self', url: 'https://git.example.com/gitlab/' },
          { id: 'saas', url: 'https://gitlab.com' },
          { id: 'hub', url: 'https://github.com' },
          { id: 'broken', url: 'not a url' },
        ],
        [
          { forge: 'self', include: ['*'] },
          { forge: 'saas', include: ['shapes/*', '/widgets'] },
          { forge: 'hub', include: ['*'] },
        ],
        ['example.org/acme-private/*'],
        [
          { forge: 'hub', path: 'acme-private/kit' },
          { forge: 'saas', path: 'gears/round/cog' },
          { forge: 'self', path: 'ignored/repo' },
        ],
      ),
    ).toEqual([
      'example.org/acme-private/*',
      'git.example.com/gitlab',
      'github.com/acme-private',
      'gitlab.com/gears',
      'gitlab.com/shapes',
      'gitlab.com/widgets',
    ])
  })

  test('private Go modules also come from config-file forges and analyzed repositories', async () => {
    await store.analyses.add({
      repo: { forge: 'saas', path: 'gears/cog' },
      kind: 'usages',
      createdAt: at,
      data: {
        packages: [
          ...goUsed('gitlab.example/shapes/geom', 'v1.0.0'),
          ...goUsed('gitlab.com/gears/teeth', 'v0.2.0'),
          ...goUsed('example.com/acme/assert', 'v1.9.0'),
        ],
        files: 1,
        types: { status: 'skipped', reason: 'go: syntactic only' },
      },
    })
    await store.config?.put({
      type: 'forge',
      id: 'saas',
      updatedAt: at,
      data: { kind: 'gitlab', url: 'https://gitlab.com', credentialId: 'c1' },
    })
    await enable({ enabled: true, sources: { repository: false, releases: false, issues: false } })
    const asked: string[] = []
    const go: LibraryRegistry = {
      async library(ref) {
        asked.push(ref.name)
        return undefined
      },
      async archive() {
        return undefined
      },
    }
    await runLibraryIndex(
      {
        ...indexDeps(),
        config: { teams: {}, forges: { self: { url: 'https://gitlab.example' } } },
      },
      { registries: { npm: registry(), Go: go } },
    )
    expect(asked).toEqual(['example.com/acme/assert'])
  })

  test('private Go modules are internal and never reach the Go registry', async () => {
    await store.analyses.add({
      repo: { forge: 'work', path: 'games/a' },
      kind: 'usages',
      createdAt: at,
      data: {
        packages: [
          ...goUsed('git.example.com/shapes/geom/v2', 'v2.0.1'),
          ...goUsed('example.org/hidden/kit', 'v0.4.0'),
          ...goUsed('example.com/acme/assert', 'v1.9.0'),
        ],
        files: 2,
        types: { status: 'skipped', reason: 'go: syntactic only' },
      },
    })
    await store.config?.put({
      type: 'forge',
      id: 'lab',
      updatedAt: at,
      data: { kind: 'gitlab', url: 'https://git.example.com', credentialId: 'c1' },
    })
    await enable({
      enabled: true,
      goPrivate: ['example.org/hidden'],
      sources: { repository: false, releases: false, issues: false },
    })
    const asked: string[] = []
    const go: LibraryRegistry = {
      async library(ref) {
        asked.push(ref.name)
        return undefined
      },
      async archive() {
        return undefined
      },
    }
    await runLibraryIndex(indexDeps(), { registries: { npm: registry(), Go: go } })
    expect(asked).toEqual(['example.com/acme/assert'])
    expect(librariesConfig({ goPrivate: ['example.org/hidden'] })?.goPrivate).toEqual([
      'example.org/hidden',
    ])
  })

  test('the index leaves internal packages to the API catalog and records latest versions', async () => {
    await store.analyses.add({
      repo: { forge: 'work', path: 'games/engine' },
      kind: 'depgraph',
      createdAt: at,
      data: {
        layers: [
          analyzeLayer({
            id: 'packages',
            source: 'test',
            graph: {
              nodes: [
                { id: 'kit', name: 'tiny', version: '0.1.0', ecosystem: 'npm', kind: 'workspace' },
              ],
              edges: [],
            },
          }),
        ],
        errors: [],
      },
    })
    await enable({ enabled: true, sources: { repository: false, releases: false, issues: false } })
    const run = await runLibraryIndex(indexDeps(), { registries: { npm: registry() } })
    expect(run?.libraries).toBe(0)
    expect(await libraries.getLibrary({ ecosystem: 'npm', name: 'tiny' })).toBeUndefined()
    expect(await store.kv?.get('libraries:latest')).toEqual({})
  })

  test('indexes nothing while the setting is off, then runs and records the run', async () => {
    await enable({ enabled: false })
    expect(await runLibraryIndex(indexDeps(), { registries: { npm: registry() } })).toBeUndefined()
    await enable({ enabled: true, sources: { repository: false, releases: false, issues: false } })
    const run = await runLibraryIndex(indexDeps(), { registries: { npm: registry() } })
    expect(run?.error).toBeUndefined()
    expect(run?.versionsAdded).toBe(2)
    expect(
      (await libraries.listVersions({ ecosystem: 'npm', name: 'tiny' })).map((v) => [
        v.version,
        v.roles,
      ]),
    ).toEqual([
      ['1.1.0', ['latest', 'minor']],
      ['1.0.0', ['used', 'patch']],
    ])
    expect((await lastLibraryRun(store.kv))?.finishedAt).toBe(at)
  })

  test('runs after the start delay and on request, one run at a time', async () => {
    await enable({ enabled: true, sources: { repository: false, releases: false, issues: false } })
    const lines: string[] = []
    let calls = 0
    const counting: LibraryRegistry = {
      ...registry(),
      async library(ref) {
        calls += 1
        return registry().library(ref)
      },
    }
    const stop = startLibraryIndex(indexDeps(), (line) => lines.push(line), {
      registries: { npm: counting },
      startDelayMs: 0,
      pollMs: 5,
    })
    await wait(() => calls === 1 && lines.some((line) => line.includes('1 indexed')))
    await Bun.sleep(30)
    expect(calls).toBe(1)
    expect(await requestLibraryIndex(store.kv as NonNullable<Store['kv']>)).toBe(true)
    await wait(() => calls === 2)
    await Bun.sleep(30)
    await noteLibraryUses(store.kv, 'usages', now, 0)
    await wait(() => calls === 3)
    await stop()
    expect(calls).toBe(3)
    expect(await store.kv?.get('libraries:running')).toBeUndefined()
  })

  test('starts a run at once when the GitHub tokens change', async () => {
    const sources = { repository: false, releases: false, issues: false }
    await enable({ enabled: true, sources })
    const lines: string[] = []
    let calls = 0
    const counting: LibraryRegistry = {
      ...registry(),
      async library(ref) {
        calls += 1
        return registry().library(ref)
      },
    }
    const stop = startLibraryIndex(indexDeps(), (line) => lines.push(line), {
      registries: { npm: counting },
      startDelayMs: 0,
      pollMs: 5,
    })
    await wait(() => calls === 1 && lines.some((line) => line.includes('1 indexed')))
    await Bun.sleep(30)
    expect(calls).toBe(1)
    await enable({ enabled: true, sources, github: ['org-a'] })
    await wait(() => calls === 2)
    await Bun.sleep(30)
    await stop()
    expect(calls).toBe(2)
  })
})

const ownSummary = (name: string, path: string) =>
  ({ name, repo: { forge: 'work', path } }) as unknown as PublicApiPackageSummary
const visibleRepo = (repo: RepoRef) => !repo.path.startsWith('secret/')

describe('ownPackageOf', () => {
  const catalog = {
    packages: async (filter: (repo: RepoRef) => boolean) =>
      [
        ownSummary('@acme/widgets', 'libs/widgets'),
        ownSummary('@acme/widgets-extra', 'libs/extra'),
        ownSummary('@acme/widgets/sub', 'libs/sub'),
        ownSummary('@other/hidden', 'secret/hidden'),
      ].filter((item) => filter(item.repo)),
  }

  test('picks the longest package name that the path names or deep imports from', async () => {
    const own = ownPackageOf(catalog, visibleRepo)
    expect(await own('@acme/widgets')).toBe('@acme/widgets')
    expect(await own('@acme/widgets/lib/round')).toBe('@acme/widgets')
    expect(await own('@acme/widgets-extra/lib/x')).toBe('@acme/widgets-extra')
    expect(await own('@acme/widgets/sub/deep')).toBe('@acme/widgets/sub')
    expect(await own('@acme/widgetsfoo')).toBeUndefined()
  })

  test('does not reveal packages of repositories the filter rejects', async () => {
    expect(await ownPackageOf(catalog, visibleRepo)('@other/hidden/lib/x')).toBeUndefined()
    expect(await ownPackageOf(catalog, () => true)('@other/hidden/lib/x')).toBe('@other/hidden')
  })
})

const version = (value: string, analysisId: string) => ({
  version: value,
  head: false,
  analysisId,
  analyzedAt: '',
  exports: 1,
})

describe('ownPackageSource', () => {
  const files: Record<string, string> = {
    'stores/gauge/package.json': '{"name":"@acme/gauge"}',
    'stores/gauge/src/index.ts': 'export const one = 1\nexport const two = 2\n',
  }
  const reads: { file: string; ref?: string }[] = []
  const forge = {
    readFile: async (_repo: string, file: string, ref?: string) => {
      reads.push({ file, ...(ref ? { ref } : {}) })
      return files[file]
    },
    listFiles: async (_repo: string, options?: { path?: string }) =>
      Object.keys(files)
        .filter((file) => file.startsWith(`${options?.path ?? ''}/`))
        .map((file) => ({ path: file, type: 'file' as const })),
  } as unknown as GitForge
  const catalog = {
    resolve: async (_filter: unknown, name: string, query: { version?: string } = {}) =>
      name === '@acme/gauge' && query.version !== '9.9.9'
        ? ({
            record: {
              id: 'a2',
              repo: { forge: 'work', path: 'libs/stores' },
              ref: 'c0ffee12',
              createdAt: '',
              packages: [],
            },
            package: { name: '@acme/gauge', dir: 'stores/gauge', private: false, entries: [] },
            version: version('2.0.0', 'a2'),
            versions: [version('2.0.0', 'a2'), version('1.0.0', 'a1')],
            alsoIn: [],
          } as unknown as Awaited<ReturnType<ApiCatalog['resolve']>>)
        : undefined,
  }
  const source = ownPackageSource({
    catalog,
    filter: () => true,
    forgeOf: (name) => (name === 'work' ? forge : undefined),
  })

  test('reads a file of the package folder at the recorded commit', async () => {
    const text = await source({ package: '@acme/gauge', path: 'src/index.ts', start: 2 })
    expect(reads.at(-1)).toEqual({ file: 'stores/gauge/src/index.ts', ref: 'c0ffee12' })
    expect(text).toContain(
      '# src/index.ts of @acme/gauge@2.0.0 (work:libs/stores, folder `stores/gauge` at c0ffee12)',
    )
    expect(text).toContain('    2 export const two = 2')
    expect(text).not.toContain('export const one')
    expect(text).toContain('Other versions: 1.0.0')
  })

  test('lists the package folder and explains what it cannot read', async () => {
    const listing = await source({ package: '@acme/gauge' })
    expect(listing).toContain('- package.json')
    expect(listing).toContain('- src/index.ts')
    expect(await source({ package: '@acme/gauge', path: '../secret' })).toContain(
      'inside the package folder',
    )
    expect(await source({ package: '@acme/gauge', version: '9.9.9' })).toContain(
      'is not in the catalog',
    )
  })
})
