import { beforeEach, describe, expect, test } from 'bun:test'

import type {
  InboxFeed,
  LearningCreateResult,
  LearningList,
  LearningView,
  ReactionTotalsList,
} from '@holtkeeper/api'
import type { AuthProvider } from '@holtkeeper/auth'
import { headerAuth } from '@holtkeeper/auth-header'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import type { GitForge } from '@holtkeeper/forge'
import { builtinSettings } from '@holtkeeper/settings'
import type { Learning, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'

let store: Store

const config = parseConfig({
  forges: { work: { kind: 'gitlab', url: 'https://forge.test', create: () => ({}) as GitForge } },
  teams: {
    toys: { owns: ['work:toys/*'] },
    shop: { owns: ['work:shop/*'] },
  },
})

const vault = aesVault('v'.repeat(32))
const at = '2026-11-04T09:31:00.000Z'

const learning = (id: string, overrides: Partial<Learning> = {}): Learning => ({
  id,
  text: 'Keep tween presets in the presets table.',
  key: `keep tween presets in the presets table ${id}`,
  scope: { repos: ['work:toys/kite'] },
  origin: 'reply',
  status: 'pending',
  sources: [
    {
      repo: 'work:toys/kite',
      mergeRequest: 4,
      discussionId: 'disc-1',
      noteId: '2',
      author: 'robin',
      at,
    },
  ],
  createdAt: at,
  updatedAt: at,
  activeAt: '2026-11-07T09:31:00.000Z',
  lastReinforcedAt: at,
  uses: 0,
  actedOn: 0,
  votesUp: 0,
  votesDown: 0,
  ...overrides,
})

let clock = 0
const setup = (auth: AuthProvider = noAuth()) =>
  createApp({
    config,
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [],
    now: () => new Date(Date.UTC(2026, 10, 4, 12, clock++)),
  })

const teams = headerAuth({
  roles: {
    reader: [{ scope: { teams: ['toys'] }, actions: ['knowledge:read'] }],
    member: [{ scope: { teams: ['toys'] }, actions: ['knowledge:read', 'knowledge:write'] }],
  },
})
const as = (role: string) => ({ 'x-forwarded-user': role, 'x-forwarded-groups': role })

const send = (
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

beforeEach(async () => {
  store = memoryStore()
  await store.learnings.put(learning('l1'))
  await store.learnings.put(
    learning('l2', {
      text: 'Round every till total to cents.',
      key: 'round every till total to cents',
      scope: { repos: ['work:shop/till'] },
    }),
  )
})

describe('learning routes', () => {
  test('lists what the caller may read, with whether it may decide', async () => {
    const app = setup(teams)
    const member = (await (
      await send(app, 'GET', '/api/learnings', undefined, as('member'))
    ).json()) as LearningList
    expect(member.learnings.map((row) => [row.id, row.canEdit, row.status])).toEqual([
      ['l1', true, 'pending'],
    ])
    const reader = (await (
      await send(app, 'GET', '/api/learnings?status=pending,active', undefined, as('reader'))
    ).json()) as LearningList
    expect(reader.learnings.map((row) => [row.id, row.canEdit])).toEqual([['l1', false]])
    expect(
      (await send(app, 'GET', '/api/learnings?status=maybe', undefined, as('reader'))).status,
    ).toBe(400)
    const filtered = (await (
      await send(setup(), 'GET', '/api/learnings?repo=work:shop/till')
    ).json()) as LearningList
    expect(filtered.learnings.map((row) => row.id)).toEqual(['l2'])
  })

  test('a learning past its approval delay reads active, with when it expires', async () => {
    await store.learnings.put(learning('l3', { key: 'old', activeAt: '2026-11-01T00:00:00.000Z' }))
    const app = setup()
    const list = (await (
      await send(app, 'GET', '/api/learnings?status=active')
    ).json()) as LearningList
    expect(list.learnings.map((row) => [row.id, row.expiresAt])).toEqual([
      ['l3', '2027-02-02T09:31:00.000Z'],
    ])
  })

  test('approving activates now, rejecting keeps it out; both need knowledge:write', async () => {
    const app = setup(teams)
    expect((await send(app, 'POST', '/api/learnings/l1/approve', {}, as('reader'))).status).toBe(
      403,
    )
    expect((await send(app, 'POST', '/api/learnings/l2/approve', {}, as('member'))).status).toBe(
      403,
    )
    const approved = (await (
      await send(app, 'POST', '/api/learnings/l1/approve', {}, as('member'))
    ).json()) as LearningView
    expect(approved).toMatchObject({ status: 'active', decidedBy: 'header:member' })
    expect((await send(app, 'POST', '/api/learnings/l1/approve', {}, as('member'))).status).toBe(
      409,
    )
    const rejected = (await (
      await send(app, 'POST', '/api/learnings/l1/reject', {}, as('member'))
    ).json()) as LearningView
    expect(rejected.status).toBe('rejected')
    const actions = (await store.audit.list()).events.map((event) => event.action)
    expect(actions).toContain('learning.approve')
    expect(actions).toContain('learning.reject')
  })

  test('editing re-keys the text and moving the scope needs write on the new one', async () => {
    const app = setup(teams)
    const edited = (await (
      await send(
        app,
        'PATCH',
        '/api/learnings/l1',
        { text: 'Keep kite presets in one table.', files: ['src/presets/**'] },
        as('member'),
      )
    ).json()) as LearningView
    expect(edited).toMatchObject({
      text: 'Keep kite presets in one table.',
      key: 'keep kite presets in one table',
      files: ['src/presets/**'],
      editedBy: 'header:member',
    })
    expect(
      (
        await send(
          app,
          'PATCH',
          '/api/learnings/l1',
          { scope: { repos: ['work:shop/till'] } },
          as('member'),
        )
      ).status,
    ).toBe(403)
    const cleared = (await (
      await send(app, 'PATCH', '/api/learnings/l1', { files: null }, as('member'))
    ).json()) as LearningView
    expect(cleared.files).toBeUndefined()
    expect(
      (await send(app, 'PATCH', '/api/learnings/missing', { text: 'x' }, as('member'))).status,
    ).toBe(404)
  })

  test('a person writes an active learning; the same text reinforces the existing one', async () => {
    const app = setup(teams)
    const response = await send(
      app,
      'POST',
      '/api/learnings',
      { text: 'Name kite colors after the palette.', scope: { teams: ['toys'] } },
      as('member'),
    )
    expect(response.status).toBe(201)
    const created = (await response.json()) as LearningCreateResult
    expect(created).toMatchObject({
      status: 'added',
      learning: { origin: 'person', status: 'active', decidedBy: 'header:member' },
    })
    const again = (await (
      await send(
        app,
        'POST',
        '/api/learnings',
        { text: 'Name kite colors after the palette!', scope: { teams: ['toys'] } },
        as('member'),
      )
    ).json()) as LearningCreateResult
    expect(again.status).toBe('merged')
    expect(again.learning.id).toBe(created.learning.id)
    expect(
      (
        await send(
          app,
          'POST',
          '/api/learnings',
          { text: 'Anything.', scope: { teams: ['shop'] } },
          as('member'),
        )
      ).status,
    ).toBe(403)
    expect((await send(app, 'POST', '/api/learnings', { text: 'x', scope: {} })).status).toBe(400)
  })

  test('deleting removes it and is audited', async () => {
    const app = setup()
    expect((await send(app, 'DELETE', '/api/learnings/l1')).status).toBe(204)
    expect(await store.learnings.get('l1')).toBeUndefined()
    const [event] = (await store.audit.list()).events
    expect(event).toMatchObject({
      action: 'learning.delete',
      target: { type: 'learning', id: 'l1' },
    })
  })

  test('pending learnings wait in the Inbox of people who may decide them', async () => {
    const app = setup(teams)
    const feed = (await (
      await send(app, 'GET', '/api/inbox', undefined, as('member'))
    ).json()) as InboxFeed
    const items = [...feed.mine, ...feed.teams]
    expect(items.map((item) => [item.id, item.kind])).toEqual([['learning:l1', 'learning']])
    expect(items[0]).toMatchObject({
      href: '/knowledge/learnings?learning=l1',
      dueAt: '2026-11-07T09:31:00.000Z',
    })
    const reader = (await (
      await send(app, 'GET', '/api/inbox', undefined, as('reader'))
    ).json()) as InboxFeed
    expect([...reader.mine, ...reader.teams]).toEqual([])
  })

  test('reaction totals per category', async () => {
    await store.learnings.putReactions({
      repo: 'work:toys/kite',
      mergeRequest: 4,
      noteId: '1',
      category: 'style',
      up: 0,
      down: 2,
      updatedAt: at,
    })
    const app = setup(teams)
    const totals = (await (
      await send(
        app,
        'GET',
        '/api/learnings/reactions?repo=work:toys/kite',
        undefined,
        as('reader'),
      )
    ).json()) as ReactionTotalsList
    expect(totals.totals).toEqual([{ category: 'style', comments: 1, up: 0, down: 2 }])
    expect(
      (
        await send(
          app,
          'GET',
          '/api/learnings/reactions?repo=work:shop/till',
          undefined,
          as('reader'),
        )
      ).status,
    ).toBe(403)
    expect(
      (await send(app, 'GET', '/api/learnings/reactions', undefined, as('reader'))).status,
    ).toBe(400)
  })
})
