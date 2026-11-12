import { beforeEach, describe, expect, test } from 'bun:test'

import type { Principal } from '@holtkeeper/access'
import type { KnowledgeDetail, KnowledgeList, RepoList, RepoOverview } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { type DepEdge, type DepNode, analyzeLayer } from '@holtkeeper/depgraph'
import { latestVersions } from '@holtkeeper/libraries'
import { builtinSettings } from '@holtkeeper/settings'
import type { StackData } from '@holtkeeper/stack'
import type { KnowledgeEntry, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { builtinAnalyses } from '../src/analyses.ts'
import { createApiCatalog } from '../src/api-surface/catalog.ts'
import { createUsageIndex } from '../src/api-surface/usages.ts'
import { createApp } from '../src/app.ts'
import { agentCatalogContext } from '../src/tools/registry.ts'
import { parseSubject } from '../src/tools/who-uses.ts'
import {
  canReadShared,
  canSeeCatalog,
  canSeeSnippets,
  crossTeamOf,
  scopeOwner,
} from '../src/visibility.ts'

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
    shapes: [
      { scope: { groups: ['shapes'] }, actions: ['analyses:read', 'knowledge:read', 'repos:read'] },
    ],
    outsider: [{ scope: { groups: ['shapes'] }, actions: ['ai:read'] }],
    viewer: [{ scope: { groups: ['shapes'] }, actions: ['repos:read'] }],
    analyst: [{ scope: { groups: ['shapes'] }, actions: ['analyses:read', 'settings:read'] }],
  },
})
const asShapes = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'shapes' }
const asOutsider = { 'x-forwarded-user': 'eve', 'x-forwarded-groups': 'outsider' }
const asViewer = { 'x-forwarded-user': 'vic', 'x-forwarded-groups': 'viewer' }
const asAnalyst = { 'x-forwarded-user': 'ana', 'x-forwarded-groups': 'analyst' }
const asAdmin = { 'x-forwarded-user': 'ada', 'x-forwarded-groups': 'admin' }

const at = '2026-11-10T00:00:00.000Z'

const principal = (grants: Principal['grants']): Principal => ({
  id: 'p',
  name: 'p',
  provider: 'test',
  grants,
})
const repo = (path: string, groups: string[]) => ({ forge: 'work', path, groups })

let store: Store
let app: ReturnType<typeof createApp>

const npm = (id: string, name: string, version?: string, kind: DepNode['kind'] = 'package') => ({
  id,
  name,
  ...(version ? { version } : {}),
  ecosystem: 'npm',
  kind,
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

const stack = (group: string, uses: Record<string, string>): StackData => ({
  group,
  checkedAt: at,
  soonDays: 180,
  repos: Object.keys(uses).map((path) => ({ path, files: ['.nvmrc'] })),
  components: [
    {
      id: 'node',
      name: 'Node.js',
      kind: 'runtime',
      latest: '26.1.0',
      cycles: [
        { cycle: '26', eol: '2029-04-30' },
        { cycle: '18', eol: '2025-04-30', lts: true },
      ],
      usages: Object.entries(uses).map(([path, version]) => ({
        repo: path,
        file: '.nvmrc',
        via: 'version-file',
        declared: version,
        version,
      })),
    },
  ],
  conventions: Object.keys(uses).map((path) => ({
    repo: path,
    file: '.editorconfig',
    mode: 'exact',
    status: 'matches',
    problems: [],
  })),
  notes: [],
})

const note = (id: string, fields: Partial<KnowledgeEntry>) =>
  store.knowledge.put({
    id,
    title: `Note ${id}`,
    body: 'Body.',
    kind: 'decision',
    scope: { groups: ['colors'] },
    topics: [],
    appliesTo: ['*'],
    status: 'accepted',
    evidence: [],
    source: 'human',
    author: 'header:ann',
    createdAt: at,
    updatedAt: at,
    ...fields,
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

beforeEach(async () => {
  store = memoryStore()
  const vault = aesVault('v'.repeat(32))
  app = createApp({
    config,
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: builtinAnalyses,
    now: () => new Date(at),
  })
  await depgraph(
    'shapes/circle',
    [npm('circle', 'circle', undefined, 'workspace'), npm('w@1.2.0', 'widget-kit', '1.2.0')],
    [{ from: 'circle', to: 'w@1.2.0', kind: 'prod' }],
  )
  await depgraph(
    'colors/red',
    [npm('red', 'red', undefined, 'workspace'), npm('w@3.0.0', 'widget-kit', '3.0.0')],
    [{ from: 'red', to: 'w@3.0.0', kind: 'prod' }],
  )
  await latestVersions(store.kv as NonNullable<Store['kv']>).record([
    { ecosystem: 'npm', name: 'widget-kit', latest: '3.0.0', checkedAt: at },
  ])
  await store.analyses.add({
    repo: { forge: 'work', path: 'shapes' },
    kind: 'stack',
    createdAt: at,
    data: stack('shapes', { 'shapes/circle': '18' }),
  })
  await store.analyses.add({
    repo: { forge: 'work', path: 'colors' },
    kind: 'stack',
    createdAt: at,
    data: stack('colors', { 'colors/red': '26' }),
  })
  await note('shared', { visibility: 'shared', subject: 'npm:widget-kit' })
  await note('private', {})
})

const callTool = async (
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string>,
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

describe('grant matrix', () => {
  const shapes = repo('shapes/circle', ['shapes'])
  const colors = repo('colors/red', ['colors'])
  const reader = principal([{ scope: { groups: ['shapes'] }, actions: ['repos:read'] }])
  const analyst = principal([{ scope: { groups: ['shapes'] }, actions: ['analyses:read'] }])
  const nobody = principal([{ scope: { groups: ['shapes'] }, actions: ['ai:read'] }])

  test('catalog reach under each policy', () => {
    const cases: [Principal, typeof shapes, 'off' | 'metadata' | 'snippets', boolean][] = [
      [analyst, shapes, 'off', true],
      [analyst, colors, 'off', false],
      [analyst, colors, 'metadata', true],
      [reader, colors, 'metadata', true],
      [reader, shapes, 'off', false],
      [nobody, colors, 'snippets', false],
    ]
    for (const [who, target, policy, expected] of cases)
      expect(canSeeCatalog(who, target, policy)).toBe(expected)
  })

  test('snippets of other teams need the snippets level', () => {
    expect(canSeeSnippets(analyst, colors, 'metadata')).toBe(false)
    expect(canSeeSnippets(analyst, colors, 'snippets')).toBe(true)
    expect(canSeeSnippets(analyst, shapes, 'off')).toBe(true)
    expect(canSeeSnippets(nobody, colors, 'snippets')).toBe(false)
  })

  test('shared notes, the policy default and owners', () => {
    expect(canReadShared(reader, { groups: ['colors'] }, 'metadata')).toBe(true)
    expect(canReadShared(reader, { groups: ['colors'] }, 'off')).toBe(false)
    expect(crossTeamOf([])).toBe('snippets')
    expect(
      crossTeamOf([
        {
          id: 'x',
          key: 'access.crossTeam',
          scope: { all: true },
          value: 'off',
          secret: false,
          updatedAt: at,
        },
      ]),
    ).toBe('off')
    expect(
      scopeOwner(
        { groups: ['colors', ['shapes', 'colors']], repos: ['work:tools/cli', 'x/*'] },
        () => ['tools'],
      ),
    ).toEqual(['colors', 'shapes', 'tools'])
    expect(scopeOwner({ all: true }, () => ['tools'])).toEqual([])
  })
})

describe('MCP cross-team tools', () => {
  test('who_uses lists teams, repositories and versions', async () => {
    const result = await callTool('who_uses', { subject: 'npm:widget-kit' }, asShapes)
    expect(result.text).toContain('# widget-kit (npm): 2 repositories of 2 teams, latest 3.0.0')
    expect(result.text).toContain('## team colors\n- `work:colors/red` 3.0.0')
    expect(result.text).toContain('## team shapes\n- `work:shapes/circle` 1.2.0 (2 majors behind)')
    const tool = await callTool('who_uses', { subject: 'node' }, asShapes)
    expect(tool.text).toContain('# Node.js: 2 uses, latest 26.1.0')
  })

  test('who_uses stays within the caller when the policy is off', async () => {
    await crossTeam('off')
    const result = await callTool('who_uses', { subject: 'widget-kit' }, asShapes)
    expect(result.text).toContain('1 repository of 1 team')
    expect(result.text).not.toContain('colors/red')
  })

  test('stack_usage narrows to a release line and names end of life', async () => {
    const result = await callTool('stack_usage', { tool: 'node', version: '18' }, asShapes)
    expect(result.text).toContain('## team shapes')
    expect(result.text).toContain(
      '- `work:shapes/circle` 18 in `.nvmrc` (version-file), end of life',
    )
    expect(result.text).not.toContain('colors/red')
    const missing = await callTool('stack_usage', { tool: 'deno' }, asShapes)
    expect(missing.text).toContain('Known tools: node')
  })

  test('repo_stack shows runtimes, conventions and key dependencies', async () => {
    const result = await callTool('repo_stack', { repo: 'work:colors/red' }, asShapes)
    expect(result.text).toContain('# `work:colors/red` (team colors)')
    expect(result.text).toContain('- Node.js 26 (latest 26.1.0)')
    expect(result.text).toContain('- `.editorconfig`: matches')
    expect(result.text).toContain('- widget-kit 3.0.0 (npm)')
    await crossTeam('off')
    expect((await callTool('repo_stack', { repo: 'work:colors/red' }, asShapes)).isError).toBe(true)
  })

  test('callers without any read grant reach nothing', async () => {
    const result = await callTool('who_uses', { subject: 'widget-kit' }, asOutsider)
    expect(result.text).toContain('No repository you can see uses widget-kit')
  })

  test('subjects name packages or tools', () => {
    expect(parseSubject('npm:@scope/kit')).toEqual({
      kind: 'package',
      ecosystem: 'npm',
      name: '@scope/kit',
    })
    expect(parseSubject('go:example.com/kit')).toMatchObject({ ecosystem: 'Go' })
    expect(parseSubject('tool:node')).toEqual({ kind: 'tool', name: 'tool:node' })
    expect(parseSubject('widget-kit')).toEqual({ kind: 'package', name: 'widget-kit' })
  })

  test('search_knowledge includes shared notes of other teams and names the team', async () => {
    const result = await callTool('search_knowledge', { package: 'widget-kit' }, asShapes)
    expect(result.text).toBe('No accepted knowledge entry matches.')
    const bySubject = await callTool('search_knowledge', { subject: 'npm:widget-kit' }, asShapes)
    expect(bySubject.text).toContain('[kb:shared]')
    expect(bySubject.text).toContain('_shared by team colors_')
    const all = await callTool('search_knowledge', {}, asShapes)
    expect(all.text).not.toContain('[kb:private]')
  })
})

describe('knowledge routes', () => {
  test('list shared notes of other teams with their owner', async () => {
    const response = await app.request('/api/knowledge', { headers: asShapes })
    const list = (await response.json()) as KnowledgeList
    expect(list.entries.map((entry) => [entry.id, entry.owner])).toEqual([['shared', ['colors']]])
    const detail = await app.request('/api/knowledge/shared', { headers: asShapes })
    expect(((await detail.json()) as KnowledgeDetail).entry.subject).toBe('npm:widget-kit')
    expect((await app.request('/api/knowledge/private', { headers: asShapes })).status).toBe(403)
    await crossTeam('off')
    const off = (await (
      await app.request('/api/knowledge', { headers: asShapes })
    ).json()) as KnowledgeList
    expect(off.entries).toEqual([])
  })

  test('a decision about one package is created shared', async () => {
    const response = await app.request('/api/knowledge', {
      method: 'POST',
      headers: {
        'x-forwarded-user': 'jane',
        'x-forwarded-groups': 'admin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Pin widget-kit 3',
        body: 'Use widget-kit 3 everywhere.',
        kind: 'decision',
        scope: { groups: ['colors'] },
        appliesTo: ['*'],
        packages: [{ ecosystem: 'npm', name: 'widget-kit' }],
      }),
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ visibility: 'shared', subject: 'npm:widget-kit' })
  })
})

const auditRecord = (path: string) =>
  store.analyses.add({
    repo: { forge: 'work', path },
    kind: 'audit',
    createdAt: at,
    data: {},
    metrics: {
      findings: 1,
      severities: { critical: 0, high: 1, medium: 0, low: 0, unknown: 0 },
      ignored: 0,
      expired: 0,
      resolved: 0,
    },
  })

const getJson = async (path: string, headers: Record<string, string>) => {
  const response = await app.request(path, { headers })
  const body: unknown = await response.json()
  return { status: response.status, body }
}

describe('repository fields', () => {
  beforeEach(async () => {
    await Promise.all([
      ...(['shapes', 'colors'] as const).map((group) =>
        store.kv?.set(`poll-group:${group}`, {
          repos: [{ forge: 'work', path: group === 'shapes' ? 'shapes/circle' : 'colors/red' }],
          listedAt: at,
          attempts: [],
        }),
      ),
      auditRecord('shapes/circle'),
      auditRecord('colors/red'),
    ])
  })

  test('the repository list leaves out what a narrow grant may not read', async () => {
    const reader = (await getJson('/api/repos', asShapes)).body as RepoList
    expect(reader.repos.map((summary) => summary.repo.path)).toEqual(['shapes/circle'])
    const [circle] = reader.repos
    expect(Object.keys(circle?.cells ?? {}).toSorted()).toEqual(
      ['bundles', 'ci', 'coverage', 'dependencies', 'jobs', 'licenses'].toSorted(),
    )
    expect(circle).not.toHaveProperty('latestAudit')
    expect(circle).not.toHaveProperty('updates')
    expect(circle).not.toHaveProperty('configurable')
    expect(circle?.freshness).toEqual({ current: 2, total: 2 })

    const viewer = (await getJson('/api/repos', asViewer)).body as RepoList
    expect(viewer.repos.map((summary) => summary.repo.path)).toEqual(['shapes/circle'])
    expect(viewer.repos[0]?.cells).toEqual({})
    expect(viewer.repos[0]?.health).toBe('not-analysed')
    expect(viewer.repos[0]).not.toHaveProperty('freshness')
    expect(viewer.repos[0]).not.toHaveProperty('lastAnalysedAt')
  })

  test('the repository overview leaves out what a narrow grant may not read', async () => {
    const own = await getJson('/api/repos/overview?repo=work:shapes/circle', asShapes)
    expect(own.status).toBe(200)
    const overview = own.body as RepoOverview
    expect(overview.cells.security).toBeUndefined()
    expect(overview.cells.release).toBeUndefined()
    expect(overview.cards.map((card) => card.key)).not.toContain('security')
    expect(overview).not.toHaveProperty('audit')
    expect(overview).not.toHaveProperty('release')
    expect(overview.knowledge).toEqual({ sections: 0, notes: 0, proposed: 0, inherits: [] })
    expect(overview.analyses.map((record) => record.kind)).not.toContain('audit')
    expect(overview.work).not.toHaveProperty('costUsd')
    expect(overview.work).toHaveProperty('awaitingApproval')

    const narrow = (await getJson('/api/repos/overview?repo=work:shapes/circle', asAnalyst))
      .body as RepoOverview
    expect(narrow.work).not.toHaveProperty('costUsd')
    expect(narrow.work).not.toHaveProperty('awaitingApproval')
    expect(narrow.work).toMatchObject({ runs: 0, failed: 0 })

    const full = (await getJson('/api/repos/overview?repo=work:shapes/circle', asAdmin))
      .body as RepoOverview
    expect(full.analyses.map((record) => record.kind)).toContain('audit')
    expect(full.work).toMatchObject({ awaitingApproval: 0, costUsd: 0 })

    expect((await getJson('/api/repos/overview?repo=work:colors/red', asShapes)).status).toBe(403)
    expect((await getJson('/api/repos/overview?repo=work:shapes/circle', asViewer)).status).toBe(
      403,
    )
  })
})

describe('group listing', () => {
  test('a group-scoped reader gets no paths the excludes keep out', async () => {
    await store.kv?.set('poll-group:shapes', {
      repos: [{ forge: 'work', path: 'shapes/circle' }],
      matched: [
        { forge: 'work', path: 'shapes/circle' },
        { forge: 'work', path: 'shapes/kept-out' },
      ],
      listedAt: at,
      attempts: [],
    })
    const narrow = await getJson('/api/repos/updates/groups/shapes', asAnalyst)
    expect(narrow.status).toBe(200)
    expect(narrow.body).not.toHaveProperty('matched')
    expect(JSON.stringify(narrow.body)).not.toContain('shapes/kept-out')

    const admin = await getJson('/api/repos/updates/groups/shapes', asAdmin)
    expect(JSON.stringify(admin.body)).toContain('shapes/kept-out')
  })
})

const agentBase = () => ({
  catalog: createApiCatalog({ analyses: store.analyses }),
  usages: createUsageIndex({ analyses: store.analyses }),
  store,
  repo: repo('shapes/circle', ['shapes']),
  targetOf: (other: { forge: string; path: string }) => ({
    ...other,
    groups: [other.path.split('/')[0] ?? ''],
  }),
  now: () => new Date(at),
})

describe('internal agents', () => {
  const base = agentBase
  const colors = { forge: 'work', path: 'colors/red' }

  test('reach every team under the policy, only their own team when it is off', () => {
    const open = agentCatalogContext({ ...base(), policy: 'metadata' })
    expect(open.canRead(colors)).toBe(true)
    expect(open.canReadSnippets?.(colors)).toBe(false)
    expect(open.knowledge.canReadShared?.({ groups: ['colors'] })).toBe(true)
    const closed = agentCatalogContext({ ...base(), policy: 'off' })
    expect(closed.canRead(colors)).toBe(false)
    expect(closed.canRead({ forge: 'work', path: 'shapes/square' })).toBe(true)
  })

  test('owners name a repository by its innermost groups and a scope by its outermost', () => {
    const titles: Record<string, string> = { shapes: 'Shapes', 'shapes.round': 'Shapes › Round' }
    const context = agentCatalogContext({
      ...base(),
      policy: 'metadata',
      targetOf: (other) => ({
        ...other,
        groups: other.path === 'shapes/circle' ? ['shapes.round', 'shapes'] : ['colors'],
      }),
      groupLabel: (key) => titles[key] ?? key,
    })
    expect(context.ownerOf?.({ forge: 'work', path: 'shapes/circle' })).toEqual(['Shapes › Round'])
    expect(context.ownerOf?.(colors)).toEqual(['colors'])
    expect(context.knowledge.ownerOf?.({ groups: ['shapes', 'shapes.round'] })).toEqual(['Shapes'])
    expect(context.knowledge.ownerOf?.({ groups: ['shapes.round'] })).toEqual(['Shapes › Round'])
    expect(context.knowledge.ownerOf?.({ repos: ['work:shapes/circle'] })).toEqual([
      'Shapes › Round',
    ])
  })

  test('chat follows the asker: their reach under the policy', () => {
    const asker = principal([{ scope: { groups: ['shapes'] }, actions: ['ai:read'] }])
    const chat = agentCatalogContext({ ...base(), policy: 'snippets', requester: asker })
    expect(chat.canRead(colors)).toBe(false)
    expect(chat.canRead({ forge: 'work', path: 'shapes/circle' })).toBe(false)
    const reader = principal([{ scope: { groups: ['shapes'] }, actions: ['repos:read'] }])
    expect(
      agentCatalogContext({ ...base(), policy: 'snippets', requester: reader }).canRead(colors),
    ).toBe(true)
  })
})
