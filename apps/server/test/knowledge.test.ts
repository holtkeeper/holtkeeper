import { beforeEach, describe, expect, test } from 'bun:test'

import type { KnowledgeDetail, KnowledgeList } from '@holtkeeper/api'
import type { AuthProvider } from '@holtkeeper/auth'
import { headerAuth } from '@holtkeeper/auth-header'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { KnowledgeEntry, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'

const config = parseConfig({
  forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => ({}) as never } },
  groups: {
    games: { forge: 'work', include: ['games/*'] },
    tools: { forge: 'work', include: ['tools/*'] },
  },
})

let store: Store
let clock = 0
const setup = (auth: AuthProvider = noAuth()) => {
  const vault = aesVault('v'.repeat(32))
  return createApp({
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
    now: () => new Date(Date.UTC(2026, 9, 30, 12, clock++)),
  })
}

const teams = headerAuth({
  roles: {
    'games-readers': [{ scope: { groups: ['games'] }, actions: ['knowledge:read'] }],
    'games-curators': [
      { scope: { groups: ['games'] }, actions: ['knowledge:read', 'knowledge:write'] },
    ],
  },
})
const as = (group: string) => ({ 'x-forwarded-user': 'jane', 'x-forwarded-groups': group })

const send = async (
  app: ReturnType<typeof setup>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const draft = (overrides: Record<string, unknown> = {}) => ({
  title: 'Prefer Vitest',
  body: 'Use **Vitest** for unit tests.',
  kind: 'convention',
  scope: { groups: ['games'] },
  topics: ['testing'],
  appliesTo: ['tests', 'review'],
  ...overrides,
})

const create = async (app: ReturnType<typeof setup>, overrides = {}, headers = {}) => {
  const response = await send(app, 'POST', '/api/knowledge', draft(overrides), headers)
  expect(response.status).toBe(201)
  return (await response.json()) as KnowledgeEntry
}

beforeEach(() => {
  store = memoryStore()
  clock = 0
})

describe('knowledge routes', () => {
  test('create, edit with history, curate and delete', async () => {
    const app = setup()
    const created = await create(app)
    expect(created).toMatchObject({
      status: 'accepted',
      source: 'human',
      author: 'root',
      version: 1,
      evidence: [],
    })

    const stale = await send(app, 'PUT', `/api/knowledge/${created.id}`, {
      ...draft({ title: 'Prefer Vitest 3' }),
      version: 7,
    })
    expect(stale.status).toBe(409)

    const updated = await send(app, 'PUT', `/api/knowledge/${created.id}`, {
      ...draft({ title: 'Prefer Vitest 3' }),
      version: 1,
    })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({
      title: 'Prefer Vitest 3',
      version: 2,
      status: 'accepted',
      author: 'root',
      updatedBy: 'root',
      createdAt: created.createdAt,
    })

    const archived = await send(app, 'POST', `/api/knowledge/${created.id}/archive`)
    expect(((await archived.json()) as KnowledgeEntry).status).toBe('archived')

    const detail = (await (
      await app.request(`/api/knowledge/${created.id}`)
    ).json()) as KnowledgeDetail
    expect(detail.entry.version).toBe(3)
    expect(detail.history.map((r) => [r.version, r.title, r.status])).toEqual([
      [2, 'Prefer Vitest 3', 'accepted'],
      [1, 'Prefer Vitest', 'accepted'],
    ])

    expect((await send(app, 'DELETE', `/api/knowledge/${created.id}`)).status).toBe(204)
    expect((await app.request(`/api/knowledge/${created.id}`)).status).toBe(404)
    expect((await store.activity.list()).map((e) => e.action).toReversed()).toEqual([
      'knowledge.created',
      'knowledge.updated',
      'knowledge.archived',
      'knowledge.removed',
    ])
  })

  test('validates entries', async () => {
    const app = setup()
    const error = async (body: unknown) => {
      const response = await send(app, 'POST', '/api/knowledge', body)
      expect(response.status).toBe(400)
      return ((await response.json()) as { error: string }).error
    }
    expect(await error(draft({ kind: 'migration' }))).toBe(
      'packages: a migration must name its packages',
    )
    expect(await error(draft({ scope: {} }))).toBe('scope: scope must not be empty')
    expect(await error(draft({ appliesTo: [] }))).toContain('appliesTo')
    expect(await error(draft({ supersedes: 'missing' }))).toBe('supersedes: unknown entry')
    expect(await error('nope')).toBeString()
    expect((await app.request('/api/knowledge?status=maybe')).status).toBe(400)
  })

  test('accepting a proposal archives the entry it supersedes', async () => {
    const app = setup()
    const old = await create(app, { title: 'Use Jest' })
    const proposal = await create(app, {
      title: 'Use Vitest instead of Jest',
      supersedes: old.id,
      status: 'proposed',
    })
    expect(proposal.status).toBe('proposed')
    const accepted = await send(app, 'POST', `/api/knowledge/${proposal.id}/accept`)
    expect(((await accepted.json()) as KnowledgeEntry).status).toBe('accepted')
    expect((await store.knowledge.get(old.id))?.status).toBe('archived')

    const rejected = await send(app, 'POST', `/api/knowledge/${old.id}/reject`)
    expect(((await rejected.json()) as KnowledgeEntry).status).toBe('rejected')
    expect((await send(app, 'POST', `/api/knowledge/${old.id}/explode`)).status).toBe(404)
  })

  test('lists with filters and full-text search', async () => {
    const app = setup()
    await create(app, { title: 'Snapshot tests are banned', topics: ['testing'] })
    await create(app, {
      title: 'React 19 refs',
      body: 'Pass ref as a prop.',
      kind: 'migration',
      topics: ['react'],
      packages: [{ ecosystem: 'npm', name: 'react', from: '>=18 <19', to: '>=19 <20' }],
      status: 'proposed',
    })
    await create(app, { title: 'Tools use Go', scope: { groups: ['tools'] }, topics: [] })

    const list = async (query: string) =>
      ((await (await app.request(`/api/knowledge${query}`)).json()) as KnowledgeList).entries.map(
        (entry) => entry.title,
      )
    expect(await list('')).toEqual(['Tools use Go', 'React 19 refs', 'Snapshot tests are banned'])
    expect(await list('?status=accepted&kind=convention,migration')).toEqual([
      'Tools use Go',
      'Snapshot tests are banned',
    ])
    expect(await list('?kind=migration&package=npm:react')).toEqual(['React 19 refs'])
    expect(await list('?topic=testing')).toEqual(['Snapshot tests are banned'])
    expect(await list('?q=snap')).toEqual(['Snapshot tests are banned'])
    expect(await list('?repo=work:tools/cli')).toEqual(['Tools use Go'])
    expect(await list('?limit=1')).toHaveLength(1)
    const searched = (await (await app.request('/api/knowledge?q=react')).json()) as KnowledgeList
    expect(searched.entries[0]?.score).toBeGreaterThan(0)
  })

  test('checks permissions against the entry scope', async () => {
    const root = setup()
    const games = await create(root, { title: 'Games rule' })
    const global = await create(root, { title: 'Global rule', scope: { all: true } })
    const tools = await create(root, { title: 'Tools rule', scope: { groups: ['tools'] } })
    const app = setup(teams)
    const reader = as('games-readers')
    const curator = as('games-curators')

    expect((await app.request('/api/knowledge')).status).toBe(401)
    const visible = (await (
      await app.request('/api/knowledge', { headers: reader })
    ).json()) as KnowledgeList
    expect(visible.entries.map((e) => e.id)).toEqual([games.id])

    const forRepo = (await (
      await app.request('/api/knowledge?repo=work:games/app', { headers: reader })
    ).json()) as KnowledgeList
    expect(forRepo.entries.map((e) => e.id).toSorted()).toEqual([games.id, global.id].toSorted())
    expect(
      (await app.request('/api/knowledge?repo=work:tools/cli', { headers: reader })).status,
    ).toBe(403)

    expect((await app.request(`/api/knowledge/${games.id}`, { headers: reader })).status).toBe(200)
    expect((await app.request(`/api/knowledge/${tools.id}`, { headers: reader })).status).toBe(403)
    expect((await send(app, 'POST', '/api/knowledge', draft(), reader)).status).toBe(403)
    expect(
      (await send(app, 'POST', `/api/knowledge/${games.id}/archive`, undefined, reader)).status,
    ).toBe(403)

    await create(app, { title: 'Curated' }, curator)
    expect(
      (await send(app, 'POST', '/api/knowledge', draft({ scope: { all: true } }), curator)).status,
    ).toBe(403)
    expect(
      (
        await send(
          app,
          'PUT',
          `/api/knowledge/${games.id}`,
          draft({ scope: { groups: ['games', 'tools'] } }),
          curator,
        )
      ).status,
    ).toBe(403)
    expect(
      (await send(app, 'DELETE', `/api/knowledge/${global.id}`, undefined, curator)).status,
    ).toBe(403)
    expect(
      (await send(app, 'DELETE', `/api/knowledge/${games.id}`, undefined, curator)).status,
    ).toBe(204)
  })
})
