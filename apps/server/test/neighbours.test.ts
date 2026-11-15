import { beforeEach, describe, expect, test } from 'bun:test'

import type { GuideChainView, KnowledgeCitations, KnowledgeList } from '@holtkeeper/api'
import type { AuthProvider } from '@holtkeeper/auth'
import { headerAuth } from '@holtkeeper/auth-header'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import type { ReviewData } from '@holtkeeper/review'
import { builtinSettings } from '@holtkeeper/settings'
import type { KnowledgeEntry, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'
import { createNeighbourIndex, inFleet, neighbourReadable } from '../src/neighbours.ts'

const config = parseConfig({
  forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => ({}) as never } },
  fleet: { work: { include: ['lab/*'], exclude: ['lab/old'] } },
  teams: {
    widgets: { owns: ['work:acme/round/**', 'work:acme/oval/**'] },
    gizmo: { owns: ['work:acme/square/*'] },
  },
})

let store: Store
const at = '2026-11-01T10:00:00.000Z'

const pkg = (name: string) => ({
  name,
  versions: ['1.0.0'],
  ranges: ['^1.0.0'],
  workspaces: ['.'],
  count: 1,
  files: 1,
  exports: [],
})
const shared = ['react', 'react-dom', 'widget-kit', 'shape-utils', 'sprite-loader']
const usages = (path: string, names: string[]) =>
  store.analyses.add({
    repo: { forge: 'work', path },
    kind: 'usages',
    createdAt: at,
    data: { packages: names.map(pkg), files: 3, types: { status: 'skipped' } },
  })

const entry = (id: string, overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry => ({
  id,
  title: `Note ${id}`,
  body: 'Load sprites lazily.',
  kind: 'convention',
  scope: { repos: ['work:acme/square/web'] },
  topics: [],
  appliesTo: ['*'],
  status: 'accepted',
  evidence: [],
  source: 'human',
  author: 'jane',
  createdAt: at,
  updatedAt: at,
  version: 1,
  ...overrides,
})

const setup = (auth: AuthProvider = noAuth()) => {
  const vault = aesVault('v'.repeat(32))
  return createApp({
    config,
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [],
    now: () => new Date('2026-11-15T12:00:00.000Z'),
  })
}

const target = (path: string) => ({
  forge: 'work',
  path,
  teams: path.startsWith('acme/square') ? ['gizmo'] : path.startsWith('acme/') ? ['widgets'] : [],
})

beforeEach(() => {
  store = memoryStore()
})

describe('neighbour index', () => {
  test('neighbours are fleet repositories alike by dependencies, outside the own family', async () => {
    await usages('acme/round/web', shared)
    await usages('acme/square/web', [...shared, 'extra-lib'])
    await usages('acme/oval/web', shared.slice(0, 4))
    await usages('outside/web', shared)
    await usages('lab/old', shared)
    await usages('acme/round/api', ['express', 'some-lib'])
    let now = 0
    const index = createNeighbourIndex({ store, config, now: () => now })
    expect(await index.neighboursOf({ forge: 'work', path: 'acme/round/web' })).toEqual([
      { repo: target('acme/square/web'), similarity: 0.833 },
      { repo: target('acme/oval/web'), similarity: 0.8 },
    ])
    expect(await index.neighboursOf({ forge: 'work', path: 'outside/web' })).toEqual([])

    await store.families.put({
      id: 'f-web',
      name: 'Web',
      members: ['work:acme/oval/web', 'work:acme/round/web'],
      createdBy: 'jane',
      createdAt: at,
      updatedAt: at,
    })
    // Cached for ten minutes.
    expect(await index.neighboursOf({ forge: 'work', path: 'acme/round/web' })).toHaveLength(2)
    now = 11 * 60_000
    expect(await index.neighboursOf({ forge: 'work', path: 'acme/round/web' })).toEqual([
      { repo: target('acme/square/web'), similarity: 0.833 },
    ])
    expect(await index.neighboursOf({ forge: 'work', path: 'acme/square/web' })).toEqual([
      { repo: target('acme/round/web'), similarity: 0.833, family: 'f-web' },
      { repo: target('acme/oval/web'), similarity: 0.667, family: 'f-web' },
    ])
  })

  test('inFleet follows includes, excludes and team patterns', () => {
    expect(inFleet(config, { forge: 'work', path: 'lab/new' })).toBeTrue()
    expect(inFleet(config, { forge: 'work', path: 'lab/old' })).toBeFalse()
    expect(inFleet(config, { forge: 'work', path: 'acme/square/web' })).toBeTrue()
    expect(inFleet(config, { forge: 'other', path: 'lab/new' })).toBeFalse()
  })
})

describe('neighbourReadable', () => {
  const round = target('acme/round/web')

  test("the repository's own teams read their entries; other teams' only when shared", () => {
    const readable = neighbourReadable({ config, repo: round, policy: 'metadata' })
    expect(readable(entry('oval', { scope: { repos: ['work:acme/oval/web'] } }))).toBeTrue()
    expect(readable(entry('folder', { scope: { repos: ['work:acme/oval/**'] } }))).toBeTrue()
    expect(readable(entry('team', { scope: { teams: ['widgets'] } }))).toBeTrue()
    expect(readable(entry('square'))).toBeFalse()
    expect(readable(entry('gizmo', { scope: { teams: ['gizmo'] } }))).toBeFalse()
    expect(readable(entry('shared', { visibility: 'shared' }))).toBeTrue()
    expect(
      neighbourReadable({ config, repo: round, policy: 'off' })(
        entry('shared', { visibility: 'shared' }),
      ),
    ).toBeFalse()
    expect(
      neighbourReadable({ config, repo: target('lab/new'), policy: 'snippets' })(
        entry('oval', { scope: { repos: ['work:acme/oval/web'] } }),
      ),
    ).toBeFalse()
  })

  test('a person the agent works for must be able to read the entry too', () => {
    const outsider = {
      id: 'sam',
      kind: 'user' as const,
      name: 'Sam',
      provider: 'header',
      grants: [],
    }
    const readable = neighbourReadable({
      config,
      repo: round,
      policy: 'metadata',
      requester: outsider,
    })
    expect(readable(entry('oval', { scope: { repos: ['work:acme/oval/web'] } }))).toBeFalse()
    expect(readable(entry('shared', { visibility: 'shared' }))).toBeFalse()
    const reader = {
      ...outsider,
      grants: [
        {
          scope: { teams: ['widgets'] },
          actions: ['knowledge:read' as const, 'repos:read' as const],
        },
      ],
      teamDefs: { widgets: { owns: config.teams.widgets?.owns ?? [] } },
    }
    const forReader = neighbourReadable({
      config,
      repo: round,
      policy: 'metadata',
      requester: reader,
    })
    expect(forReader(entry('oval', { scope: { repos: ['work:acme/oval/web'] } }))).toBeTrue()
    expect(forReader(entry('shared', { visibility: 'shared' }))).toBeTrue()
  })
})

describe('Guide chain', () => {
  test('knowledge of similar repositories is the last layer, within what the viewer reads', async () => {
    await usages('acme/round/web', shared)
    await usages('acme/square/web', [...shared, 'extra-lib'])
    await usages('acme/oval/web', shared)
    await store.knowledge.put(entry('k-shared', { visibility: 'shared', appliesTo: ['review'] }))
    await store.knowledge.put(entry('k-gizmo', { appliesTo: ['review'] }))
    await store.knowledge.put(entry('k-oval', { scope: { repos: ['work:acme/oval/web'] } }))
    await store.knowledge.put(entry('k-own', { scope: { teams: ['widgets'] } }))
    const chain = (await (
      await setup().request('/api/guide/chain?repo=work:acme/round/web&section=review')
    ).json()) as GuideChainView
    const layers = chain.sections[0]?.layers ?? []
    expect(layers.map((layer) => layer.kind)).toEqual(['notes', 'neighbours'])
    const near = layers[1]
    expect(near?.source).toBe('Similar repositories: acme/oval/web · acme/square/web')
    expect(near?.text).toContain('[kb:k-shared]')
    expect(near?.text).toContain('[kb:k-oval]')
    expect(near?.text).not.toContain('[kb:k-gizmo]')
    expect(near?.text).not.toContain('[kb:k-own]')
    expect(layers[0]?.text).toContain('[kb:k-own]')
  })
})

const review = (mr: number, comments: { id: string; body: string }[]): ReviewData => ({
  mergeRequest: {
    id: mr,
    title: `Add widget ${mr}`,
    webUrl: `https://forge.test/acme/round/web/-/merge_requests/${mr}`,
    sourceBranch: 'feature/widget',
    targetBranch: 'main',
    author: 'alex',
  },
  head: 'a41c9e2',
  mode: 'full',
  verdict: 'needs-changes',
  summary: '',
  comments: comments.map((comment) => ({
    id: comment.id,
    path: 'src/widget.ts',
    line: 3,
    severity: 'minor',
    category: 'maintainability',
    title: `Finding ${comment.id}`,
    body: comment.body,
    source: 'agent',
    posted: true,
    href: `https://forge.test/acme/round/web/-/merge_requests/${mr}#note_${comment.id}`,
  })),
  threads: [],
  skipped: [],
  stats: {
    files: 1,
    changedLines: 10,
    dropped: { belowSeverity: 0, overLimit: 0, duplicates: 0, invalid: 0 },
  },
  approved: false,
  checks: [],
})

describe('knowledge citations', () => {
  test('entries carry how the review comments citing them fared', async () => {
    await store.knowledge.put(entry('k-square-0001', { visibility: 'shared' }))
    await store.knowledge.put(entry('k-own', { scope: { teams: ['widgets'] } }))
    const addReview = (path: string, mr: number, comments: { id: string; body: string }[]) =>
      store.analyses.add({
        repo: { forge: 'work', path },
        kind: 'review',
        ref: `!${mr}`,
        createdAt: `2026-11-0${mr}T10:00:00.000Z`,
        data: review(mr, comments),
      })
    await addReview('acme/round/web', 1, [
      { id: 'f1', body: 'Per [kb:k-square-0001], load lazily.' },
      { id: 'f2', body: 'See [kb:k-own].' },
    ])
    await addReview('acme/round/web', 2, [{ id: 'f3', body: 'Again [kb:k-squar] here.' }])
    await addReview('acme/square/web', 3, [{ id: 'f4', body: 'As [kb:k-square-0001] says.' }])
    const signal = (repo: string, mr: number, findingId: string, extra: object) =>
      store.learnings.putReactions({
        repo,
        mergeRequest: mr,
        noteId: `n-${findingId}`,
        category: 'maintainability',
        findingId,
        up: 0,
        down: 0,
        updatedAt: at,
        ...extra,
      })
    await signal('work:acme/round/web', 1, 'f1', { mergeRequestState: 'merged', outcome: 'fixed' })
    await signal('work:acme/square/web', 3, 'f4', {
      mergeRequestState: 'merged',
      outcome: 'ignored',
      humanReplies: 1,
    })

    const app = setup()
    const list = (await (await app.request('/api/knowledge')).json()) as KnowledgeList
    const byId = new Map(list.entries.map((item) => [item.id, item.citations]))
    // `k-squar` is too short a prefix to count.
    expect(byId.get('k-square-0001')).toEqual({
      comments: 2,
      fixed: 1,
      resolved: 0,
      dismissed: 1,
      open: 0,
      closed: 0,
      unknown: 0,
      replied: 1,
      up: 0,
      down: 0,
      fromNeighbours: 1,
      lastCitedAt: '2026-11-03T10:00:00.000Z',
    })
    expect(byId.get('k-own')).toMatchObject({ comments: 1, open: 1, fromNeighbours: 0 })

    const detail = (await (
      await app.request('/api/knowledge/k-square-0001/citations')
    ).json()) as KnowledgeCitations
    expect(detail.comments.map((c) => [c.repo, c.mergeRequest, c.outcome, c.neighbour])).toEqual([
      ['work:acme/square/web', 3, 'dismissed', false],
      ['work:acme/round/web', 1, 'fixed', true],
    ])
    expect(detail.hidden).toBe(0)

    const auth = headerAuth({
      roles: {
        squares: [{ scope: { teams: ['gizmo'] }, actions: ['knowledge:read', 'analyses:read'] }],
      },
    })
    const headers = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'squares' }
    const limited = (await (
      await setup(auth).request('/api/knowledge/k-square-0001/citations', { headers })
    ).json()) as KnowledgeCitations
    expect(limited.summary.comments).toBe(2)
    expect(limited.comments.map((c) => c.repo)).toEqual(['work:acme/square/web'])
    expect(limited.hidden).toBe(1)
    const refused = await setup(auth).request('/api/knowledge/k-own/citations', { headers })
    expect(refused.status).toBe(403)
  })
})
