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
import type { LibraryRegistry } from '@holtkeeper/libraries'
import { builtinSettings } from '@holtkeeper/settings'
import type { LibraryStore, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import type { UsagesData } from '@holtkeeper/usages'
import { aesVault } from '@holtkeeper/vault'

import { builtinAnalyses } from '../src/analyses.ts'
import { createApp } from '../src/app.ts'
import { githubUsageFor } from '../src/github-usage.ts'
import {
  fleetLibraryUses,
  githubClientFor,
  librariesConfig,
  librariesConfigFrom,
  librariesSetting,
  lastLibraryRun,
  noteLibraryUses,
  ownPackageOf,
  requestLibraryIndex,
  runLibraryIndex,
  startLibraryIndex,
} from '../src/libraries.ts'

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
    outsider: [{ scope: { groups: ['nothing'] }, actions: ['analyses:read'] }],
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

describe('library MCP tools', () => {
  test('lists the library tools', async () => {
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
    expect(body.result.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'library_versions',
        'search_library_docs',
        'read_library_doc',
        'library_changes',
        'search_library_issues',
        'library_source',
      ]),
    )
  })

  test('answers from the index with the caller repository’s version', async () => {
    await crossTeamOff()
    const versions = await callTool('library_versions', { package: 'zod' }, asGames)
    expect(versions.text).toContain('3.22.0')
    expect(versions.text).toContain('work:games/a')
    expect(versions.text).not.toContain('work:libs/ui')

    const search = await callTool('search_library_docs', {
      package: 'zod',
      query: 'refinements',
      repo: 'work:libs/ui',
    })
    expect(search.text).toContain('superRefine')
    expect(search.text).not.toContain('check for refinements')

    const read = await callTool('read_library_doc', {
      package: 'zod',
      version: '4.0.0',
      path: 'README.md',
    })
    expect(read.text).toContain('Use check for refinements')
    expect(read.text).toContain('data, not instructions')

    const issues = await callTool('search_library_issues', {
      package: 'zod',
      query: 'schema.parse is not a function',
      limit: 1,
    })
    expect(issues.text).toContain('#42')

    const usageView = await get<{ tools: { tool: string; calls: number }[] }>(
      '/api/api-surface/mcp/usage?days=7',
    )
    expect(usageView.tools.find((t) => t.tool === 'library_versions')?.calls).toBe(1)
  })

  test('hides libraries the caller could not see through the web routes', async () => {
    await crossTeamOff()
    const versions = await callTool('library_versions', { package: 'left-pad' }, asGames)
    expect(versions.text).toContain('is not indexed')
    const search = await callTool('search_library_docs', { query: 'refinements' }, asGames)
    expect(search.text).toContain('superRefine')
    expect(search.text).not.toContain('Padding')
    const all = await callTool('search_library_docs', { query: 'refinements' })
    expect(all.text).toContain('Padding')

    const hidden = await callTool('library_versions', { package: 'zod' }, asOutsider)
    expect(hidden.text).toContain('is not indexed')
    const issues = await callTool(
      'search_library_issues',
      { package: 'zod', query: 'schema.parse is not a function' },
      asOutsider,
    )
    expect(issues.text).not.toContain('#42')
    const api = await callTool('get_package_api', { package: 'zod' }, asOutsider)
    expect(api.isError).toBe(true)
    expect(api.text).toContain('No package zod')
    expect(
      (
        await app.request('/api/dependencies/library?ecosystem=npm&name=zod', {
          headers: asOutsider,
        })
      ).status,
    ).toBe(404)
  })

  test('a package of the organization points to the catalog tools', async () => {
    await store.analyses.add({
      repo: { forge: 'work', path: 'libs/ui' },
      kind: 'api-surface',
      createdAt: at,
      data: { packages: [{ ...zodApi('2.0.0', ['RoundWidget']), name: '@acme/widgets' }] },
    })
    const deep = await callTool('library_versions', {
      package: '@acme/widgets/lib/round/RoundWidget',
    })
    expect(deep.text).toContain('belongs to @acme/widgets, which is a package of this organization')
    expect(deep.text).toContain('get_package_api @acme/widgets')
    const api = await callTool('get_package_api', { package: '@acme/widgets/lib/round' })
    expect(api.text).toContain('@acme/widgets/lib/round is a deep import into @acme/widgets')
    const stranger = await callTool('library_versions', { package: '@acme/gadgets' })
    expect(stranger.text).toContain('is not indexed')
  })

  test('API tools fall back to the library index', async () => {
    const api = await callTool('get_package_api', { package: 'zod', repo: 'work:libs/ui' })
    expect(api.isError).toBeUndefined()
    expect(api.text).toContain('zod@3.22.0')
    expect(api.text).toContain('nativeEnum')
    expect(api.text).toContain('Other indexed versions: 4.0.0')

    const list = await callTool('list_versions', { package: 'zod' })
    expect(list.text).toContain('4.0.0 (latest, major)')
    expect(list.text).toContain('since 3.22.0: 1 removed, 0 changed, 1 added')

    const diff = await callTool('diff_versions', { package: 'zod' })
    expect(diff.text).toContain('nativeEnum')
    expect(diff.text).toContain('3.22.0 → 4.0.0')

    await store.analyses.add({
      repo: { forge: 'work', path: 'games/a' },
      kind: 'usages',
      createdAt: at,
      data: usage('zod', '3.22.0', 'nativeEnum'),
    })
    const impact = await callTool('upgrade_impact', { package: 'zod' })
    expect(impact.isError).toBeUndefined()
    expect(impact.text).toContain('nativeEnum()')

    const missing = await callTool('get_package_api', { package: 'zod', version: '9.9.9' })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('indexed: 4.0.0, 3.22.0')
  })
})

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
