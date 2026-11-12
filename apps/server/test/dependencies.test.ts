import { beforeEach, describe, expect, test } from 'bun:test'

import type {
  CreateMcpTokenResult,
  DependencyApi,
  DependencyDetail,
  DependencySearchResult,
  DependencyTable,
  DependencyUpgrade,
  LibrarySearchResult,
} from '@holtkeeper/api'
import type { ApiPackage } from '@holtkeeper/api-surface'
import { type ArtifactStore, memoryArtifactStore } from '@holtkeeper/artifacts'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { type DepEdge, type DepNode, analyzeLayer } from '@holtkeeper/depgraph'
import { latestVersions } from '@holtkeeper/libraries'
import { builtinSettings } from '@holtkeeper/settings'
import type { KnowledgeEntry, LibraryStore, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import type { UsagesData } from '@holtkeeper/usages'
import { aesVault } from '@holtkeeper/vault'

import { builtinAnalyses } from '../src/analyses.ts'
import { createApp } from '../src/app.ts'
import { librariesSetting } from '../src/libraries.ts'

const config = parseConfig({
  forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => ({}) as never } },
  groups: {
    games: { forge: 'work', include: ['games/*'] },
    tools: { forge: 'work', include: ['tools/*'] },
  },
})

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['*'] }],
    games: [{ scope: { groups: ['games'] }, actions: ['analyses:read', 'knowledge:read'] }],
  },
})
const asAdmin = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'admin' }
const asGames = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'games' }

const at = '2026-10-30T12:00:00.000Z'
const widget = { ecosystem: 'npm', name: 'widget-kit' } as const

let store: Store
let libraries: LibraryStore
let artifacts: ArtifactStore
let app: ReturnType<typeof createApp>

const npm = (id: string, name: string, version?: string, kind: DepNode['kind'] = 'package') => ({
  id,
  name,
  ...(version ? { version } : {}),
  ecosystem: 'npm',
  kind,
})
const go = (id: string, name: string, version?: string): DepNode => ({
  id,
  name,
  ...(version ? { version } : {}),
  ecosystem: 'Go',
  kind: version ? 'package' : 'workspace',
})

const depgraph = (path: string, nodes: DepNode[], edges: DepEdge[]) =>
  store.analyses.add({
    repo: { forge: 'work', path },
    kind: 'depgraph',
    createdAt: at,
    data: {
      layers: [analyzeLayer({ id: 'packages', source: 'test', graph: { nodes, edges } })],
      errors: [],
    },
  })

const widgetApi = (version: string, names: string[]): ApiPackage => ({
  name: 'widget-kit',
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
        file: 'index.d.ts',
        line: 1,
      })),
    },
  ],
})

const putApi = async (version: string, names: string[]) =>
  (
    await artifacts.put(new TextEncoder().encode(JSON.stringify([widgetApi(version, names)])), {
      name: `npm/widget-kit/${version}/api.json`,
      contentType: 'application/json',
    })
  ).id

const usages: UsagesData = {
  packages: [
    {
      name: 'widget-kit',
      versions: ['1.4.0'],
      ranges: ['^1.4.0'],
      workspaces: ['arcade'],
      count: 1,
      files: 1,
      exports: [
        {
          name: 'makeWidget',
          subpath: '.',
          count: 1,
          files: 1,
          kinds: { call: 1 },
          members: [],
          props: [],
          spread: 0,
          sites: [
            {
              file: 'src/board.ts',
              line: 4,
              column: 1,
              kind: 'call',
              snippet: 'makeWidget()',
              snippetLine: 4,
            },
          ],
        },
      ],
    },
  ],
  files: 3,
  types: { status: 'used' },
}

const knowledge = (id: string, fields: Partial<KnowledgeEntry>) =>
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
    createdAt: at,
    updatedAt: at,
    ...fields,
  })

const seed = async () => {
  await depgraph(
    'games/arcade',
    [
      npm('arcade', 'arcade', undefined, 'workspace'),
      npm('w@1.4.0', 'widget-kit', '1.4.0'),
      npm('e@0.3.0', '@games/engine', '0.3.0'),
    ],
    [
      { from: 'arcade', to: 'w@1.4.0', kind: 'prod' },
      { from: 'arcade', to: 'e@0.3.0', kind: 'prod' },
    ],
  )
  await depgraph(
    'games/engine',
    [npm('engine', '@games/engine', '0.5.0', 'workspace'), npm('w@3.2.0', 'widget-kit', '3.2.0')],
    [{ from: 'engine', to: 'w@3.2.0', kind: 'prod' }],
  )
  await depgraph(
    'tools/cli',
    [go('cli', 'example.com/tools/cli'), go('s@v2.1.0', 'example.com/shapes/v2', 'v2.1.0')],
    [{ from: 'cli', to: 's@v2.1.0', kind: 'prod' }],
  )
  await store.analyses.add({
    repo: { forge: 'work', path: 'games/arcade' },
    kind: 'usages',
    createdAt: at,
    data: usages,
  })
  await latestVersions(store.kv as NonNullable<Store['kv']>).record([
    { ...widget, latest: '3.2.0', checkedAt: at },
    { ecosystem: 'Go', name: 'example.com/shapes', latest: 'v3.0.0', checkedAt: at },
  ])
  await store.analyses.add({
    repo: { forge: 'work', path: 'games/arcade' },
    kind: 'audit',
    createdAt: at,
    data: {
      scanner: 'osv-scanner',
      findings: [
        {
          id: 'GHSA-aaaa-bbbb-cccc',
          aliases: [],
          summary: 'Widgets leak memory',
          severity: 'high',
          url: 'https://osv.example/GHSA-aaaa-bbbb-cccc',
          package: { name: 'widget-kit', version: '1.4.0', ecosystem: 'npm' },
          source: 'pnpm-lock.yaml',
          fixedVersions: ['1.4.2'],
        },
      ],
      ignored: [],
      expired: [],
      fixes: [],
      resolved: [],
      changedFiles: [],
    },
  })
  await store.analyses.add({
    repo: { forge: 'work', path: 'games/arcade' },
    kind: 'licenses',
    createdAt: at,
    data: {
      tool: { name: 'osv-scanner' },
      policy: { allow: ['MIT'], deny: [], ignore: [] },
      packages: [
        {
          name: 'widget-kit',
          version: '1.4.0',
          ecosystem: 'npm',
          sources: ['pnpm-lock.yaml'],
          licenses: ['MIT'],
          verdict: 'allowed',
        },
      ],
    },
  })
  await store.analyses.add({
    repo: { forge: 'work', path: 'games/arcade' },
    kind: 'renovate',
    createdAt: at,
    data: {
      status: 'ok',
      mode: 'merge-requests',
      readOnly: false,
      renovateVersion: '41.0.0',
      startedAt: at,
      durationMs: 1000,
      dependencies: 2,
      outdated: 1,
      managers: [{ manager: 'npm', files: 1, dependencies: 2 }],
      updates: [
        {
          dependency: 'widget-kit',
          manager: 'npm',
          file: 'package.json',
          current: '1.4.0',
          next: '3.2.0',
          type: 'major',
          vulnerability: false,
          pending: false,
          mergeRequest: 7,
        },
      ],
      deprecated: [],
      mergeRequests: [
        {
          id: 7,
          url: 'https://gitlab.test/games/arcade/-/merge_requests/7',
          title: 'Update widget-kit to v3',
          branch: 'renovate/widget-kit-3.x',
          state: 'open',
          draft: false,
          pipeline: 'failed',
          types: ['major'],
          updates: 1,
        },
      ],
      problems: [],
      output: '',
    },
  })
  await knowledge('agent-pick', {
    title: 'Wrap widget-kit in a board helper',
    source: 'agent',
    updatedAt: '2026-10-29T00:00:00.000Z',
    packages: [{ ecosystem: 'npm', name: 'widget-kit' }],
  })
  await knowledge('team-pin', {
    title: 'Stay on widget-kit 3',
    updatedAt: '2026-10-01T00:00:00.000Z',
    packages: [{ ecosystem: 'npm', name: 'widget-kit' }],
  })
  await knowledge('proposed', {
    title: 'Drop widget-kit',
    status: 'proposed',
    packages: [{ ecosystem: 'npm', name: 'widget-kit' }],
  })
  await knowledge('tools-only', {
    title: 'Tools team note',
    scope: { groups: ['tools'] },
    packages: [{ ecosystem: 'npm', name: 'widget-kit' }],
  })
  await knowledge('tools-shared', {
    title: 'Tools team picked widget-kit 3',
    scope: { groups: ['tools'] },
    visibility: 'shared',
    subject: 'npm:widget-kit',
    updatedAt: '2026-09-01T00:00:00.000Z',
  })

  await libraries.putLibrary({
    ...widget,
    description: 'Widgets',
    latest: '3.2.0',
    sources: {},
    updatedAt: at,
  })
  await libraries.putVersion({
    ...widget,
    version: '1.4.0',
    roles: ['used'],
    usedBy: ['work:games/arcade'],
    api: await putApi('1.4.0', ['makeWidget', 'paint']),
    sources: {},
    updatedAt: at,
  })
  await libraries.putVersion({
    ...widget,
    version: '3.2.0',
    roles: ['latest', 'used'],
    usedBy: ['work:games/engine'],
    api: await putApi('3.2.0', ['paint']),
    sources: { archive: { status: 'ok', at } },
    updatedAt: at,
  })
  await libraries.replaceChunks(widget, '3.2.0', 'archive', [
    {
      ...widget,
      id: 'readme-3',
      source: 'archive',
      path: 'README.md',
      headings: ['widget-kit'],
      text: 'Paint widgets on a board.',
    },
    {
      ...widget,
      id: 'changelog-3',
      source: 'archive',
      path: 'CHANGELOG.md',
      headings: ['Changelog', '3.0.0'],
      text: 'Removed makeWidget; use paint.',
    },
  ])
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
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: [...builtinSettings, librariesSetting],
    analyses: builtinAnalyses,
    artifacts,
    now: () => new Date(at),
  })
  await seed()
})

const crossTeam = (level: 'off' | 'metadata' | 'snippets') =>
  store.settings.put({
    id: 'cross-team',
    key: 'access.crossTeam',
    scope: { all: true },
    value: level,
    secret: false,
    updatedAt: at,
  })

const get = async <T>(path: string, headers: Record<string, string> = asAdmin) => {
  const response = await app.request(path, { headers })
  expect(response.status).toBe(200)
  return (await response.json()) as T
}

describe('dependency table', () => {
  test('one row per library, Go included, internal packages flagged and counted apart', async () => {
    const table = await get<DependencyTable>('/api/dependencies')
    expect(
      table.libraries.map((row) => [
        row.ecosystem,
        row.name,
        row.internal,
        row.latest,
        row.majorsBehind,
        row.reposBehind,
      ]),
    ).toEqual([
      ['npm', 'widget-kit', false, '3.2.0', 2, 1],
      ['Go', 'example.com/shapes', false, 'v3.0.0', 1, 1],
      ['npm', '@games/engine', true, '0.5.0', 2, 1],
    ])
    const [row] = table.libraries
    expect(row?.usedBy).toEqual([
      { repo: 'work:games/arcade', versions: ['1.4.0'] },
      { repo: 'work:games/engine', versions: ['3.2.0'] },
    ])
    expect(row?.versions).toEqual([
      { version: '1.4.0', repos: 1, majorsBehind: 2 },
      { version: '3.2.0', repos: 1, majorsBehind: 0 },
    ])
    expect(row?.advisories).toEqual({ count: 1, severity: 'high' })
    expect(row?.licenses).toEqual(['MIT'])
    expect(row?.licenseVerdict).toBe('allowed')
    expect(row?.renovate).toBe('broken')
    expect(table.totals).toEqual({
      libraries: 2,
      internal: 1,
      behindMajor: 2,
      withAdvisories: 1,
      renovateOpen: 0,
      renovateBroken: 1,
    })
    expect(table.repos.map((repo) => [repo.repo.path, repo.groups, repo.dependencies])).toEqual([
      ['games/arcade', ['games'], 2],
      ['games/engine', ['games'], 1],
      ['tools/cli', ['tools'], 1],
    ])
  })

  test('other teams count through the cross-team catalog; audits still need audits:read', async () => {
    const table = await get<DependencyTable>('/api/dependencies', asGames)
    expect(table.repos.map((repo) => [repo.repo.path, repo.groups])).toEqual([
      ['games/arcade', ['games']],
      ['games/engine', ['games']],
      ['tools/cli', ['tools']],
    ])
    expect(table.libraries.find((row) => row.name === 'widget-kit')?.advisories).toEqual({
      count: 0,
    })
  })

  test('with the cross-team catalog off, only readable repositories count', async () => {
    await crossTeam('off')
    const table = await get<DependencyTable>('/api/dependencies', asGames)
    expect(table.repos.map((repo) => repo.repo.path)).toEqual(['games/arcade', 'games/engine'])
    expect(table.libraries.map((row) => row.name)).toEqual(['widget-kit', '@games/engine'])
    expect(table.libraries[0]?.advisories).toEqual({ count: 0 })
  })

  test('search matches names, prefixes first, and needs q', async () => {
    const found = await get<DependencySearchResult>('/api/dependencies/search?q=E')
    expect(found.libraries.map((hit) => [hit.name, hit.usedBy])).toEqual([
      ['example.com/shapes', 1],
      ['widget-kit', 2],
      ['@games/engine', 1],
    ])
    expect(found.libraries[1]).toEqual({
      ecosystem: 'npm',
      name: 'widget-kit',
      internal: false,
      latest: '3.2.0',
      usedBy: 2,
    })
    const one = await get<DependencySearchResult>('/api/dependencies/search?q=e&limit=1')
    expect(one.libraries).toHaveLength(1)
    await crossTeam('off')
    const own = await get<DependencySearchResult>('/api/dependencies/search?q=shapes', asGames)
    expect(own.libraries).toEqual([])
    expect((await app.request('/api/dependencies/search', { headers: asAdmin })).status).toBe(400)
  })
})

describe('dependency detail', () => {
  test('joins users, advisories, licenses, decisions, merge requests and docs', async () => {
    const detail = await get<DependencyDetail>(
      '/api/dependencies/library?ecosystem=npm&name=widget-kit',
      asGames,
    )
    expect(detail).toMatchObject({
      internal: false,
      latest: '3.2.0',
      latestCheckedAt: at,
      description: 'Widgets',
    })
    expect(detail.usedBy.map((user) => [user.repo.path, user.groups, user.majorsBehind])).toEqual([
      ['games/arcade', ['games'], 2],
      ['games/engine', ['games'], 0],
    ])
    expect(detail.indexed.map((version) => version.version)).toEqual(['3.2.0', '1.4.0'])
    expect(detail.licenses).toEqual([
      {
        version: '1.4.0',
        licenses: ['MIT'],
        verdicts: [{ verdict: 'allowed', repos: ['work:games/arcade'] }],
      },
    ])
    expect(detail.decisions.map((decision) => decision.id)).toEqual([
      'team-pin',
      'tools-shared',
      'agent-pick',
    ])
    expect(detail.decisions[1]).toMatchObject({ owner: ['tools'], shared: true })
    expect(detail.decisions[0]).toMatchObject({ owner: [], shared: false })
    expect(detail.mergeRequests).toEqual([
      {
        repo: 'work:games/arcade',
        id: 7,
        url: 'https://gitlab.test/games/arcade/-/merge_requests/7',
        title: 'Update widget-kit to v3',
        status: 'broken',
        next: '3.2.0',
      },
    ])
    expect(detail.docs).toEqual({
      version: '3.2.0',
      documents: [
        { source: 'archive', path: 'CHANGELOG.md', chunks: 1 },
        { source: 'archive', path: 'README.md', chunks: 1 },
      ],
    })

    const admin = await get<DependencyDetail>(
      '/api/dependencies/library?ecosystem=npm&name=widget-kit',
    )
    expect(admin.advisories.map((advisory) => [advisory.id, advisory.versions])).toEqual([
      ['GHSA-aaaa-bbbb-cccc', ['1.4.0']],
    ])
    expect(admin.decisions.map((decision) => decision.id)).toEqual([
      'tools-only',
      'team-pin',
      'tools-shared',
      'agent-pick',
    ])
  })

  test('a Go library by its module path without the major suffix', async () => {
    const detail = await get<DependencyDetail>(
      '/api/dependencies/library?ecosystem=go&name=example.com/shapes',
    )
    expect(detail.usedBy.map((user) => [user.repo.path, user.versions])).toEqual([
      ['tools/cli', ['v2.1.0']],
    ])
    expect(detail.latest).toBe('v3.0.0')
  })

  test('libraries no readable repository uses do not exist; bad parameters are rejected', async () => {
    await crossTeam('off')
    const missing = await app.request(
      '/api/dependencies/library?ecosystem=go&name=example.com/shapes',
      { headers: asGames },
    )
    expect(missing.status).toBe(404)
    expect(
      (await app.request('/api/dependencies/library?ecosystem=rust&name=x', { headers: asAdmin }))
        .status,
    ).toBe(400)
    expect(
      (await app.request('/api/dependencies/library?ecosystem=npm', { headers: asAdmin })).status,
    ).toBe(400)
  })
})

const gizmo = () =>
  store.analyses.add({
    repo: { forge: 'work', path: 'tools/kit' },
    kind: 'api-surface',
    createdAt: at,
    ref: 'v0.2.0',
    data: {
      packages: [
        {
          name: '@tools/gizmo',
          version: '0.2.0',
          description: 'Gizmos for tools',
          private: false,
          dir: '.',
          entries: [
            {
              subpath: './extra',
              symbols: [
                {
                  name: 'spin',
                  kind: 'function',
                  signature: 'function spin(): void',
                  file: 'src/extra.ts',
                  line: 1,
                },
              ],
            },
            {
              subpath: '.',
              symbols: [
                {
                  name: 'gizmo',
                  kind: 'function',
                  signature: 'function gizmo(): void',
                  doc: 'Makes a gizmo.',
                  file: 'src/index.ts',
                  line: 1,
                },
              ],
            },
          ],
        },
      ],
    },
  })

const status = async (path: string, headers: Record<string, string> = asAdmin) =>
  (await app.request(path, { headers })).status

describe('internal packages only the API catalog knows', () => {
  test('the library answers with the catalog facts and no users', async () => {
    const { id } = await gizmo()
    const detail = await get<DependencyDetail>(
      '/api/dependencies/library?ecosystem=npm&name=@tools/gizmo',
    )
    expect(detail).toMatchObject({
      ecosystem: 'npm',
      name: '@tools/gizmo',
      internal: true,
      latest: '0.2.0',
      description: 'Gizmos for tools',
      usedBy: [],
      versions: [],
      advisories: [],
    })
    const api = await get<DependencyApi>('/api/dependencies/api?ecosystem=npm&name=@tools/gizmo')
    expect(api).toEqual({
      ecosystem: 'npm',
      name: '@tools/gizmo',
      definedIn: { repo: { forge: 'work', path: 'tools/kit' }, ref: 'v0.2.0', analysisId: id },
      version: '0.2.0',
      api: { exports: 2, documented: 1 },
      subpaths: ['.', './extra'],
    })
  })

  test('narrow grants find them only in readable repositories', async () => {
    await gizmo()
    expect(await status('/api/dependencies/library?ecosystem=npm&name=@tools/gizmo', asGames)).toBe(
      200,
    )
    await crossTeam('off')
    expect(await status('/api/dependencies/library?ecosystem=npm&name=@tools/gizmo', asGames)).toBe(
      404,
    )
    expect(await status('/api/dependencies/api?ecosystem=npm&name=@tools/gizmo', asGames)).toBe(404)
    expect(await status('/api/dependencies/library?ecosystem=npm&name=@tools/gizmo')).toBe(200)
  })
})

describe('dependency API', () => {
  test('a third-party library from its newest indexed API, without definedIn', async () => {
    const api = await get<DependencyApi>(
      '/api/dependencies/api?ecosystem=npm&name=widget-kit',
      asGames,
    )
    expect(api).toEqual({
      ecosystem: 'npm',
      name: 'widget-kit',
      version: '3.2.0',
      api: { exports: 1, documented: 0 },
      subpaths: ['.'],
    })
  })

  test('used libraries without a recorded API answer empty; unknown ones are not found', async () => {
    expect(
      await get<DependencyApi>('/api/dependencies/api?ecosystem=npm&name=@games/engine'),
    ).toEqual({ ecosystem: 'npm', name: '@games/engine', subpaths: [] })
    expect(await status('/api/dependencies/api?ecosystem=npm&name=left-pad')).toBe(404)
    expect(await status('/api/dependencies/api?ecosystem=rust&name=x')).toBe(400)
    await crossTeam('off')
    expect(
      await status('/api/dependencies/api?ecosystem=go&name=example.com/shapes', asGames),
    ).toBe(404)
  })
})

describe('dependency table cache', () => {
  test('answers again without reading records until a newer record lands', async () => {
    let reads = 0
    const latest = store.analyses.latest.bind(store.analyses)
    store.analyses.latest = async (query) => {
      reads += 1
      return latest(query)
    }
    const first = await get<DependencyTable>('/api/dependencies')
    const counted = reads
    expect(counted).toBeGreaterThan(0)
    expect(await get<DependencyTable>('/api/dependencies')).toEqual(first)
    expect(reads).toBe(counted)

    await crossTeam('off')
    await get<DependencyTable>('/api/dependencies', asGames)
    expect(reads).toBeGreaterThan(counted)

    await depgraph(
      'tools/cli',
      [go('cli', 'example.com/tools/cli'), go('s@v3.0.0', 'example.com/shapes/v3', 'v3.0.0')],
      [{ from: 'cli', to: 's@v3.0.0', kind: 'prod' }],
    )
    const next = await get<DependencyTable>('/api/dependencies')
    expect(next.libraries.find((row) => row.name === 'example.com/shapes')?.usedBy).toEqual([
      { repo: 'work:tools/cli', versions: ['v3.0.0'] },
    ])
  })
})

describe('dependency upgrade', () => {
  test('from the oldest used version to the latest: changes, API diff and affected uses', async () => {
    const upgrade = await get<DependencyUpgrade>(
      '/api/dependencies/upgrade?ecosystem=npm&name=widget-kit',
      asGames,
    )
    expect(upgrade.from).toBe('1.4.0')
    expect(upgrade.to).toBe('3.2.0')
    expect(upgrade.api).toEqual([
      {
        change: 'removed',
        subpath: '.',
        name: 'makeWidget',
        kind: 'function',
        before: 'declare function makeWidget(): void',
      },
    ])
    expect(upgrade.impact?.affected).toEqual(['work:games/arcade'])
    expect(upgrade.impact?.items[0]?.level).toBe('breaking')
    expect(upgrade.changes).toContain('Removed makeWidget')
    expect(upgrade.notes).toEqual([])
  })

  test('says why parts are missing', async () => {
    const shapes = await get<DependencyUpgrade>(
      '/api/dependencies/upgrade?ecosystem=go&name=example.com/shapes',
    )
    expect(shapes.from).toBe('v2.1.0')
    expect(shapes.notes).toEqual(['example.com/shapes is not in the library index.'])
    const unindexed = await get<DependencyUpgrade>(
      '/api/dependencies/upgrade?ecosystem=npm&name=widget-kit&from=2.0.0',
    )
    expect(unindexed.notes[0]).toContain('No indexed API for 2.0.0')
    const internal = await get<DependencyUpgrade>(
      '/api/dependencies/upgrade?ecosystem=npm&name=@games/engine',
    )
    expect(internal).toMatchObject({ from: '0.3.0', to: '0.5.0' })
    expect(internal.notes).toEqual([
      'The API catalog has no two versions of @games/engine to compare.',
    ])
  })
})

describe('dependency docs search', () => {
  test('searches the docs of libraries readable repositories use', async () => {
    const result = await get<LibrarySearchResult>(
      '/api/dependencies/docs?q=widgets&name=widget-kit',
      asGames,
    )
    expect(result.hits.map((hit) => hit.chunk.id)).toEqual(['readme-3'])
    expect((await get<LibrarySearchResult>('/api/dependencies/docs?q=')).hits).toEqual([])
  })

  test('MCP tokens read the dependency routes', async () => {
    const created = await app.request('/api/api-surface/mcp/tokens', {
      method: 'POST',
      headers: { ...asAdmin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'cli' }),
    })
    const { secret } = (await created.json()) as CreateMcpTokenResult
    const table = await get<DependencyTable>('/api/dependencies', {
      authorization: `Bearer ${secret}`,
    })
    expect(table.libraries).toHaveLength(3)
  })
})
