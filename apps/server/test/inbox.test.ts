import { beforeEach, describe, expect, test } from 'bun:test'

import type { Scope } from '@holtkeeper/access'
import type { InboxCount, InboxFeed, InboxItem } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import type { ReleaseBoardRow } from '@holtkeeper/release'
import { builtinSettings } from '@holtkeeper/settings'
import type { GuideGeneratedInput, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'

let forgeCalls = 0
const config = parseConfig({
  forges: {
    work: {
      kind: 'fake',
      url: 'https://forge.test',
      create: () => {
        forgeCalls++
        throw new Error('the forge is not reachable in this test')
      },
    },
  },
  groups: {
    web: { forge: 'work', include: ['acme/web-*'] },
    pay: { forge: 'work', include: ['acme/pay-*'] },
  },
})

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['*'] }],
    lead: [{ scope: { groups: ['web', 'pay'] }, actions: ['*'] }],
    tasker: [{ scope: { groups: ['web'] }, actions: ['tasks:run', 'repos:read'] }],
    crosstasker: [
      { scope: { groups: ['web'] }, actions: ['repos:read'] },
      { scope: { repos: ['work:acme/pay-api'] }, actions: ['tasks:run'] },
    ],
    writer: [{ scope: { groups: ['web'] }, actions: ['knowledge:read', 'knowledge:write'] }],
    scribbler: [{ scope: { groups: ['web'] }, actions: ['knowledge:write'] }],
    releaser: [{ scope: { groups: ['web'] }, actions: ['releases:read', 'releases:run'] }],
    watcher: [{ scope: { groups: ['web'] }, actions: ['releases:read'] }],
    configurer: [{ scope: { groups: ['web'] }, actions: ['settings:read', 'settings:write'] }],
    tweaker: [{ scope: { groups: ['web'] }, actions: ['settings:write'] }],
    reader: [{ scope: { all: true }, actions: ['repos:read', 'knowledge:read'] }],
  },
})
const as = (role: string) => ({ 'x-forwarded-user': role, 'x-forwarded-groups': role })

let store: Store
let clock: number
let app: ReturnType<typeof createApp>

const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(`/api${path}`, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const feedOf = async (role: string) => {
  const response = await call('GET', '/inbox', as(role))
  expect(response.status).toBe(200)
  return (await response.json()) as InboxFeed
}

const ids = (items: InboxItem[]) => items.map((item) => item.id).toSorted()

const open = (items: InboxItem[]) => items.filter((item) => !item.snoozed).length

const generated = (body: string): GuideGeneratedInput => ({
  body,
  inputHash: `hash:${body}`,
  model: 'model-main',
  costUsd: 0.01,
  status: 'proposed',
  generatedAt: '2026-11-01T08:00:00.000Z',
})

const row = (path: string): ReleaseBoardRow => ({
  repo: { forge: 'work', path },
  stage: 'proposed',
  mode: 'merge-request',
  next: '1.2.0',
  ahead: 2,
  aheadCapped: false,
  unreleased: 2,
  unreleasedCapped: false,
  tickets: ['ABC-1'],
  pipelines: {},
  blockers: [],
  acceptanceRequired: true,
  reasons: [],
  leftOut: 0,
  tasks: 0,
  environments: [],
  waitingSince: '2026-11-01T07:00:00.000Z',
})

async function seed() {
  for (const [id, path, at] of [
    ['g-web', 'acme/web-shop', '2026-10-30T10:00:00.000Z'],
    ['g-pay', 'acme/pay-api', '2026-10-30T11:00:00.000Z'],
  ] as const) {
    await store.tasks.putGroup({
      id,
      kind: 'upgrade',
      title: `Upgrade some-lib in ${path}`,
      prompt: 'Upgrade some-lib to 2.0.0.',
      proposedBy: 'header:lead',
      source: { type: 'chat', threadId: 't-1' },
      repos: [`work:${path}`],
      budgetClass: 'interactive',
      createdAt: at,
      updatedAt: at,
    })
    await store.tasks.put({
      id: `${id}-1`,
      groupId: id,
      kind: 'upgrade',
      title: `Upgrade some-lib in ${path}`,
      prompt: 'Upgrade some-lib to 2.0.0.',
      repo: `work:${path}`,
      requester: 'header:lead',
      source: { type: 'chat', threadId: 't-1' },
      status: 'proposed',
      createdAt: at,
      updatedAt: at,
    })
  }
  for (const [id, scope] of [
    ['n-web', { groups: ['web'] }],
    ['n-pay', { groups: ['pay'] }],
    ['n-all', { all: true }],
  ] satisfies [string, Scope][]) {
    await store.knowledge.put({
      id,
      title: `Widgets note ${id}`,
      body: 'Use fooUtil for widgets.',
      kind: 'convention',
      scope,
      topics: [],
      appliesTo: ['*'],
      status: 'proposed',
      evidence: [],
      source: 'agent',
      author: 'header:lead',
      createdAt: '2026-10-31T09:00:00.000Z',
      updatedAt: '2026-10-31T09:00:00.000Z',
    })
  }
  for (const [id, path] of [
    ['l-web', 'acme/web-shop'],
    ['l-pay', 'acme/pay-api'],
  ] as const) {
    await store.learnings.put({
      id,
      repo: `work:${path}`,
      rule: 'Name widgets after their shape.',
      key: `name widgets ${id}`,
      section: 'review',
      suggestedScope: 'repo',
      status: 'proposed',
      sources: [],
      proposal: { by: 'header:lead', reason: 'Seen in three reviews.' },
      model: 'model-fast',
      costUsd: 0,
      createdAt: '2026-10-31T10:00:00.000Z',
      updatedAt: '2026-10-31T10:00:00.000Z',
    })
  }
  for (const path of ['acme/web-shop', 'acme/pay-api'])
    await store.guides.put({
      scope: `repo:work:${path}`,
      section: 'general',
      rules: '',
      steering: '',
      learnings: [],
      generated: generated(`- Run make check in ${path}.`),
    })
  await store.kv!.set('release:board:index', {
    repos: [
      { forge: 'work', path: 'acme/web-shop' },
      { forge: 'work', path: 'acme/pay-api' },
    ],
    readAt: '2026-11-03T11:00:00.000Z',
  })
  for (const path of ['acme/web-shop', 'acme/pay-api'])
    await store.kv!.set(`release:board:row:work:${path}`, {
      readAt: '2026-11-03T11:00:00.000Z',
      head: `head-${path}`,
      row: row(path),
    })
  for (const [id, scope] of [
    ['a-web', { groups: ['web'] }],
    ['a-pay', { groups: ['pay'] }],
  ] satisfies [string, Scope][])
    await store.settings.put({
      id,
      key: 'audit.allowlist',
      scope,
      value: [
        { id: 'GHSA-soon', reason: 'Not reachable from widgets.', expires: '2026-11-06' },
        { id: 'GHSA-past', package: 'some-lib', reason: 'Waiting for 2.0.', expires: '2026-11-01' },
        { id: 'GHSA-later', reason: 'Far away.', expires: '2027-01-30' },
        { id: 'GHSA-never', reason: 'Never expires.' },
      ],
      secret: false,
      updatedAt: '2026-10-01T00:00:00.000Z',
    })
}

beforeEach(async () => {
  forgeCalls = 0
  clock = Date.parse('2026-11-03T12:00:00.000Z')
  store = memoryStore()
  const vault = aesVault('v'.repeat(32))
  app = createApp({
    config,
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [],
    now: () => new Date(clock),
  })
  await seed()
  await store.users.putUser({
    id: 'header:lead',
    name: 'Mira K.',
    grants: [],
    disabled: false,
    sessionVersion: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
  })
})

describe('GET /api/inbox', () => {
  test('a narrow grant sees only the kinds it may decide, only where it may decide them', async () => {
    const tasker = await feedOf('tasker')
    expect(ids([...tasker.mine, ...tasker.teams])).toEqual(['task:g-web'])
    expect(tasker.mine[0]).toMatchObject({
      kind: 'task',
      groupId: 'g-web',
      taskKind: 'upgrade',
      scope: 'acme/web-shop',
      repos: [{ repo: 'work:acme/web-shop', groups: ['web'] }],
      href: '/ops/tasks?group=g-web',
      proposedBy: 'header:lead',
      snoozed: false,
    })

    const writer = await feedOf('writer')
    expect(ids([...writer.mine, ...writer.teams])).toEqual([
      'guide:repo:work:acme/web-shop:general',
      'learning:l-web',
      'note:n-web',
    ])
    const guide = writer.mine.find((item) => item.kind === 'guide')
    expect(guide).toMatchObject({
      guideScope: 'repo:work:acme/web-shop',
      section: 'general',
      inputHash: 'hash:- Run make check in acme/web-shop.',
      generatedAt: '2026-11-01T08:00:00.000Z',
    })
    expect(writer.mine.find((item) => item.kind === 'note')).toMatchObject({
      entryId: 'n-web',
      version: 1,
      scope: 'Team web',
    })
    expect(writer.mine.find((item) => item.kind === 'learning')).toMatchObject({
      learningId: 'l-web',
      section: 'review',
      suggestedScope: 'repo',
    })

    const releaser = await feedOf('releaser')
    expect(ids([...releaser.mine, ...releaser.teams])).toEqual(['release:work:acme/web-shop'])
    expect(releaser.mine[0]).toMatchObject({
      kind: 'release',
      repo: 'work:acme/web-shop',
      stage: 'proposed',
      next: '1.2.0',
      head: 'head-acme/web-shop',
      can: { accept: true, run: true },
      title: 'Release proposed, waiting for acceptance',
    })
    const watcher = await feedOf('watcher')
    expect([...watcher.mine, ...watcher.teams]).toEqual([])

    const configurer = await feedOf('configurer')
    expect(ids([...configurer.mine, ...configurer.teams])).toEqual([
      'allowlist:a-web:GHSA-past:some-lib',
      'allowlist:a-web:GHSA-soon',
    ])
    expect(configurer.mine.find((item) => item.id === 'allowlist:a-web:GHSA-soon')).toMatchObject({
      kind: 'allowlist',
      settingId: 'a-web',
      settingScope: { groups: ['web'] },
      expires: '2026-11-06',
      expired: false,
      dueAt: '2026-11-06T23:59:59.999Z',
      href: '/supply/security',
    })
    expect(
      configurer.mine.find((item) => item.id === 'allowlist:a-web:GHSA-past:some-lib'),
    ).toMatchObject({ expired: true })

    const reader = await feedOf('reader')
    expect([...reader.mine, ...reader.teams]).toEqual([])
    expect(forgeCalls).toBe(0)
  })

  test('a write grant without the matching read sees no notes, learnings, Guide text or allowlist entries', async () => {
    for (const role of ['scribbler', 'tweaker']) {
      const feed = await feedOf(role)
      expect([...feed.mine, ...feed.teams]).toEqual([])
    }
  })

  test('a cross-team run grant without repos:read there never shows the group', async () => {
    await store.settings.put({
      id: 'cross-team',
      key: 'access.crossTeam',
      scope: { all: true },
      value: 'metadata',
      secret: false,
      updatedAt: '2026-10-01T00:00:00.000Z',
    })
    const feed = await feedOf('crosstasker')
    expect(ids([...feed.mine, ...feed.teams])).toEqual([])
    expect((await call('GET', '/task-groups/g-pay', as('crosstasker'))).status).toBe(404)
  })

  test('without home groups everything is mine, oldest first', async () => {
    const feed = await feedOf('admin')
    expect(feed.teams).toEqual([])
    expect(new Set(feed.mine.map((item) => item.kind))).toEqual(
      new Set(['task', 'note', 'learning', 'guide', 'release', 'allowlist']),
    )
    expect(feed.mine).toHaveLength(15)
    const times = feed.mine.map((item) => item.createdAt)
    expect(times).toEqual(times.toSorted())
    expect(Object.keys(feed.people)).toEqual(['header:lead'])
    expect(feed.people['header:lead']?.name).toBe('Mira K.')
  })

  test('home groups split mine from teams; items above every team are mine', async () => {
    expect(
      (await call('PUT', '/me/preferences', as('admin'), { homeGroups: ['web'] })).status,
    ).toBe(200)
    const feed = await feedOf('admin')
    expect(feed.mine.every((item) => !item.repos.some((repo) => repo.groups.includes('pay')))).toBe(
      true,
    )
    expect(ids(feed.mine)).toContain('note:n-all')
    expect(ids(feed.teams)).toEqual([
      'allowlist:a-pay:GHSA-past:some-lib',
      'allowlist:a-pay:GHSA-soon',
      'guide:repo:work:acme/pay-api:general',
      'learning:l-pay',
      'note:n-pay',
      'release:work:acme/pay-api',
      'task:g-pay',
    ])
  })

  test('rejected generated text and dismissed releases leave the Inbox', async () => {
    await store.kv!.set('guide:rejected:repo:work:acme/web-shop:general', [
      {
        inputHash: 'hash:- Run make check in acme/web-shop.',
        generatedAt: '2026-11-01T08:00:00.000Z',
        by: 'header:lead',
        at: '2026-11-02T08:00:00.000Z',
      },
    ])
    await store.kv!.set('release:dismissal:work:acme/web-shop', {
      sha: 'head-acme/web-shop',
      by: 'header:lead',
      at: '2026-11-02T08:00:00.000Z',
    })
    const feed = await feedOf('admin')
    expect(ids(feed.mine)).not.toContain('guide:repo:work:acme/web-shop:general')
    expect(ids(feed.mine)).not.toContain('release:work:acme/web-shop')
    expect(ids(feed.mine)).toContain('guide:repo:work:acme/pay-api:general')
  })

  test('the 30 second cache keeps raw sources only: callers never see each other’s items', async () => {
    const first = await feedOf('tasker')
    const second = await feedOf('configurer')
    const again = await feedOf('tasker')
    expect(ids(first.mine)).toEqual(['task:g-web'])
    expect(ids(second.mine)).toEqual([
      'allowlist:a-web:GHSA-past:some-lib',
      'allowlist:a-web:GHSA-soon',
    ])
    expect(again).toEqual(first)

    await store.knowledge.put({
      id: 'n-new',
      title: 'Fresh widgets note',
      body: 'Prefer ShapeBase.',
      kind: 'convention',
      scope: { groups: ['web'] },
      topics: [],
      appliesTo: ['*'],
      status: 'proposed',
      evidence: [],
      source: 'human',
      author: 'header:lead',
      createdAt: '2026-11-03T11:59:00.000Z',
      updatedAt: '2026-11-03T11:59:00.000Z',
    })
    clock += 20_000
    expect(ids((await feedOf('writer')).mine)).not.toContain('note:n-new')
    clock += 11_000
    expect(ids((await feedOf('writer')).mine)).toContain('note:n-new')
  })

  test('a decision made through the API is seen at once', async () => {
    await feedOf('admin')
    expect((await call('POST', '/knowledge/n-web/reject', as('admin'))).status).toBe(200)
    expect(ids((await feedOf('admin')).mine)).not.toContain('note:n-web')
  })

  test('snoozed items stay in the list, marked', async () => {
    expect(
      (
        await call('POST', '/me/snoozes', as('tasker'), {
          id: 'task:g-web',
          until: '2026-11-04T12:00:00.000Z',
        })
      ).status,
    ).toBe(200)
    expect((await feedOf('tasker')).mine[0]).toMatchObject({ id: 'task:g-web', snoozed: true })
    clock = Date.parse('2026-11-04T12:00:01.000Z')
    expect((await feedOf('tasker')).mine[0]?.snoozed).toBe(false)
  })
})

describe('GET /api/inbox/count', () => {
  test('counts sections without snoozed items from stored data, with an ETag', async () => {
    expect((await call('PUT', '/me/preferences', as('lead'), { homeGroups: ['web'] })).status).toBe(
      200,
    )
    const response = await call('GET', '/inbox/count', as('lead'))
    expect(response.status).toBe(200)
    expect((await response.json()) as InboxCount).toEqual({ mine: 7, teams: 7, total: 14 })
    const etag = response.headers.get('etag')
    expect(etag).toBe('"inbox-7-7"')

    const unchanged = await call('GET', '/inbox/count', { ...as('lead'), 'if-none-match': etag! })
    expect(unchanged.status).toBe(304)
    expect(unchanged.headers.get('etag')).toBe(etag)

    await call('POST', '/me/snoozes', as('lead'), {
      id: 'task:g-pay',
      until: '2026-11-10T00:00:00.000Z',
    })
    const after = await call('GET', '/inbox/count', { ...as('lead'), 'if-none-match': etag! })
    expect(after.status).toBe(200)
    expect((await after.json()) as InboxCount).toEqual({ mine: 7, teams: 6, total: 13 })
    expect(forgeCalls).toBe(0)
  })

  test('total equals the rows of the feed that are not snoozed, for the same caller', async () => {
    expect((await call('PUT', '/me/preferences', as('lead'), { homeGroups: ['web'] })).status).toBe(
      200,
    )
    for (const id of ['task:g-web', 'note:n-pay'])
      await call('POST', '/me/snoozes', as('lead'), { id, until: '2026-11-10T00:00:00.000Z' })
    for (const role of ['lead', 'admin', 'tasker', 'writer', 'configurer', 'watcher']) {
      const feed = await feedOf(role)
      const count = (await (await call('GET', '/inbox/count', as(role))).json()) as InboxCount
      expect(count).toEqual({
        mine: open(feed.mine),
        teams: open(feed.teams),
        total: open(feed.mine) + open(feed.teams),
      })
    }
  })

  test('needs a signed-in caller', async () => {
    expect((await call('GET', '/inbox/count', {})).status).toBe(401)
  })
})
