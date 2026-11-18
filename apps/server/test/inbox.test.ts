import { beforeEach, describe, expect, test } from 'bun:test'

import type { Scope } from '@holtkeeper/access'
import type { InboxCount, InboxFeed, InboxItem, ReleaseOverview } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { type ReleaseBoardRow, releaseSettingsDefinition } from '@holtkeeper/release'
import { builtinSettings } from '@holtkeeper/settings'
import type { Learning, Store } from '@holtkeeper/store'
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
  teams: {
    web: { owns: ['work:acme/web-*'] },
    pay: { owns: ['work:acme/pay-*'] },
    docs: { title: 'Docs', owns: ['work:acme/web-docs*'] },
  },
})

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['*'] }],
    lead: [{ scope: { teams: ['web', 'pay'] }, actions: ['*'] }],
    tasker: [{ scope: { teams: ['web'] }, actions: ['tasks:run', 'repos:read'] }],
    crosstasker: [
      { scope: { teams: ['web'] }, actions: ['repos:read'] },
      { scope: { repos: ['work:acme/pay-api'] }, actions: ['tasks:run'] },
    ],
    writer: [{ scope: { teams: ['web'] }, actions: ['knowledge:read', 'knowledge:write'] }],
    scribbler: [{ scope: { teams: ['web'] }, actions: ['knowledge:write'] }],
    releaser: [{ scope: { teams: ['web'] }, actions: ['releases:read', 'releases:run'] }],
    watcher: [{ scope: { teams: ['web'] }, actions: ['releases:read'] }],
    configurer: [{ scope: { teams: ['web'] }, actions: ['settings:read', 'settings:write'] }],
    tweaker: [{ scope: { teams: ['web'] }, actions: ['settings:write'] }],
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

const learning = (id: string, scope: Scope, overrides: Partial<Learning> = {}): Learning => ({
  id,
  text: `Name widgets after their shape (${id}).`,
  key: `name widgets ${id}`,
  reason: 'Seen in three reviews.',
  scope,
  origin: 'agent',
  status: 'pending',
  sources: [{ author: 'header:lead', at: '2026-10-31T10:00:00.000Z' }],
  createdAt: '2026-10-31T10:00:00.000Z',
  updatedAt: '2026-10-31T10:00:00.000Z',
  activeAt: '2026-11-08T10:00:00.000Z',
  lastReinforcedAt: '2026-10-31T10:00:00.000Z',
  uses: 0,
  actedOn: 0,
  votesUp: 0,
  votesDown: 0,
  ...overrides,
})

const row = (path: string): ReleaseBoardRow => ({
  repo: { forge: 'work', path },
  stage: 'awaiting-version',
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
    ['l-web', { repos: ['work:acme/web-shop'] }],
    ['l-pay', { repos: ['work:acme/pay-api'] }],
    ['l-all', { all: true }],
  ] satisfies [string, Scope][])
    await store.learnings.put(learning(id, scope))
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
  await store.settings.put({
    id: 'releases-all',
    key: 'releases',
    scope: { all: true },
    value: { enabled: true, acceptance: 'manual' },
    secret: false,
    updatedAt: '2026-10-01T00:00:00.000Z',
  })
  for (const [id, scope] of [
    ['a-web', { teams: ['web'] }],
    ['a-pay', { teams: ['pay'] }],
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
    settings: [...builtinSettings, releaseSettingsDefinition],
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
      repos: [{ repo: 'work:acme/web-shop', teams: ['web'] }],
      href: '/ops/tasks?group=g-web',
      proposedBy: 'header:lead',
      snoozed: false,
    })

    const writer = await feedOf('writer')
    expect(ids([...writer.mine, ...writer.teams])).toEqual(['learning:l-web'])
    expect(writer.mine.find((item) => item.kind === 'learning')).toMatchObject({
      learningId: 'l-web',
      origin: 'agent',
      activeAt: '2026-11-08T10:00:00.000Z',
      dueAt: '2026-11-08T10:00:00.000Z',
      scope: 'acme/web-shop',
      detail: 'Seen in three reviews.',
      proposedBy: 'header:lead',
      href: '/knowledge/learnings?learning=l-web',
    })

    const releaser = await feedOf('releaser')
    expect(ids([...releaser.mine, ...releaser.teams])).toEqual(['release:work:acme/web-shop'])
    expect(releaser.mine[0]).toMatchObject({
      kind: 'release',
      repo: 'work:acme/web-shop',
      stage: 'awaiting-version',
      next: '1.2.0',
      head: 'head-acme/web-shop',
      can: { accept: true, run: true },
      title: 'Changes wait for acceptance before version 1.2.0',
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
      settingScope: { teams: ['web'] },
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

  test('a write grant without the matching read sees no learnings or allowlist entries', async () => {
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

  test('without home teams everything is mine, oldest first', async () => {
    const feed = await feedOf('admin')
    expect(feed.teams).toEqual([])
    expect(new Set(feed.mine.map((item) => item.kind))).toEqual(
      new Set(['task', 'learning', 'release', 'allowlist']),
    )
    expect(feed.mine).toHaveLength(11)
    const times = feed.mine.map((item) => item.createdAt)
    expect(times).toEqual(times.toSorted())
    expect(Object.keys(feed.people)).toEqual(['header:lead'])
    expect(feed.people['header:lead']?.name).toBe('Mira K.')
  })

  test('home teams split mine from teams; items above every team are mine', async () => {
    expect((await call('PUT', '/me/preferences', as('admin'), { homeTeams: ['web'] })).status).toBe(
      200,
    )
    const feed = await feedOf('admin')
    expect(feed.mine.every((item) => !item.repos.some((repo) => repo.teams.includes('pay')))).toBe(
      true,
    )
    expect(ids(feed.mine)).toContain('learning:l-all')
    expect(ids(feed.teams)).toEqual([
      'allowlist:a-pay:GHSA-past:some-lib',
      'allowlist:a-pay:GHSA-soon',
      'learning:l-pay',
      'release:work:acme/pay-api',
      'task:g-pay',
    ])
  })

  test('a learning names its teams by title and key, and folder patterns as written', async () => {
    await store.learnings.put(learning('l-docs', { teams: ['docs'] }))
    await store.learnings.put(learning('l-both', { teams: ['docs', 'pay'] }))
    await store.learnings.put(learning('l-folder', { repos: ['work:acme/web-*'] }))
    const items = [...(await feedOf('admin')).mine, ...(await feedOf('admin')).teams]
    expect(items.find((item) => item.id === 'learning:l-docs')).toMatchObject({
      scope: 'Team Docs (docs)',
    })
    expect(items.find((item) => item.id === 'learning:l-both')).toMatchObject({
      scope: 'Team Docs (docs), Team pay',
    })
    expect(items.find((item) => item.id === 'learning:l-folder')).toMatchObject({
      scope: 'work:acme/web-*',
    })
  })

  test('active learnings and dismissed releases leave the Inbox', async () => {
    await store.learnings.put(
      learning('l-web', { repos: ['work:acme/web-shop'] }, { status: 'active' }),
    )
    await store.learnings.put(
      learning('l-pay', { repos: ['work:acme/pay-api'] }, { activeAt: '2026-11-02T00:00:00.000Z' }),
    )
    await store.kv!.set('release:dismissal:work:acme/web-shop', {
      sha: 'head-acme/web-shop',
      by: 'header:lead',
      at: '2026-11-02T08:00:00.000Z',
    })
    const feed = await feedOf('admin')
    expect(ids(feed.mine)).not.toContain('learning:l-web')
    expect(ids(feed.mine)).not.toContain('learning:l-pay')
    expect(ids(feed.mine)).not.toContain('release:work:acme/web-shop')
    expect(ids(feed.mine)).toContain('learning:l-all')
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

    await store.learnings.put(learning('l-new', { teams: ['web'] }))
    clock += 20_000
    expect(ids((await feedOf('writer')).mine)).not.toContain('learning:l-new')
    clock += 11_000
    expect(ids((await feedOf('writer')).mine)).toContain('learning:l-new')
  })

  test('a decision made through the API is seen at once', async () => {
    await feedOf('admin')
    expect((await call('POST', '/learnings/l-web/reject', as('admin'))).status).toBe(200)
    expect(ids((await feedOf('admin')).mine)).not.toContain('learning:l-web')
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
    expect((await call('PUT', '/me/preferences', as('lead'), { homeTeams: ['web'] })).status).toBe(
      200,
    )
    const response = await call('GET', '/inbox/count', as('lead'))
    expect(response.status).toBe(200)
    expect((await response.json()) as InboxCount).toEqual({ mine: 5, teams: 5, total: 10 })
    const etag = response.headers.get('etag')
    expect(etag).toBe('"inbox-5-5"')

    const unchanged = await call('GET', '/inbox/count', { ...as('lead'), 'if-none-match': etag! })
    expect(unchanged.status).toBe(304)
    expect(unchanged.headers.get('etag')).toBe(etag)

    await call('POST', '/me/snoozes', as('lead'), {
      id: 'task:g-pay',
      until: '2026-11-10T00:00:00.000Z',
    })
    const after = await call('GET', '/inbox/count', { ...as('lead'), 'if-none-match': etag! })
    expect(after.status).toBe(200)
    expect((await after.json()) as InboxCount).toEqual({ mine: 5, teams: 4, total: 9 })
    expect(forgeCalls).toBe(0)
  })

  test('total equals the rows of the feed that are not snoozed, for the same caller', async () => {
    expect((await call('PUT', '/me/preferences', as('lead'), { homeTeams: ['web'] })).status).toBe(
      200,
    )
    for (const id of ['task:g-web', 'learning:l-pay'])
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

const putRelease = (patch: Partial<ReleaseBoardRow>, acceptanceMode?: string) =>
  store.kv!.set('release:board:row:work:acme/web-shop', {
    readAt: '2026-11-03T11:00:00.000Z',
    head: 'head-acme/web-shop',
    ...(acceptanceMode && { acceptanceMode }),
    row: { ...row('acme/web-shop'), ...patch },
  })
const setAcceptance = (acceptance: string) =>
  store.settings.put({
    id: 'releases-all',
    key: 'releases',
    scope: { all: true },
    value: { enabled: true, acceptance },
    secret: false,
    updatedAt: '2026-10-01T00:00:00.000Z',
  })
const releaseIds = async () => {
  clock += 31_000
  const feed = await feedOf('releaser')
  const count = (await (await call('GET', '/inbox/count', as('releaser'))).json()) as InboxCount
  const found = ids([...feed.mine, ...feed.teams])
  expect(count.total).toBe(found.length)
  return found
}

describe('release items', () => {
  for (const acceptance of ['none', 'manual', 'label', 'merge'])
    for (const unreleased of [0, 3])
      for (const accepted of [false, true]) {
        const shows = acceptance !== 'none' && unreleased > 0 && !accepted
        test(`acceptance ${acceptance}, ${unreleased} unreleased, ${accepted ? 'accepted' : 'not accepted'}: ${shows ? 'an item' : 'nothing'}`, async () => {
          await setAcceptance(acceptance)
          await putRelease({
            stage: unreleased > 0 ? 'awaiting-version' : 'candidate',
            unreleased,
            ...(accepted && {
              acceptance: {
                sha: 'head-acme/web-shop',
                by: 'header:lead',
                at: '2026-11-02T08:00:00.000Z',
                via: 'manual',
              },
            }),
          })
          expect(await releaseIds()).toEqual(shows ? ['release:work:acme/web-shop'] : [])
        })
      }

  for (const acceptance of ['manual', 'label', 'merge'])
    test(`acceptance ${acceptance}: an open candidate without unreleased commits is no item`, async () => {
      await setAcceptance(acceptance)
      await putRelease({
        stage: 'proposed',
        unreleased: 0,
        request: { id: 7, title: 'Release 1.2.0', webUrl: 'https://forge.test/mr/7', draft: false },
      })
      expect(await releaseIds()).toEqual([])
    })

  test('a row read under another acceptance mode is no item until it is reread', async () => {
    await setAcceptance('label')
    await putRelease({ stage: 'awaiting-version', unreleased: 3 }, 'none')
    expect(await releaseIds()).toEqual([])
    await putRelease({ stage: 'awaiting-version', unreleased: 3 }, 'label')
    expect(await releaseIds()).toEqual(['release:work:acme/web-shop'])
  })

  test('a row read under another flow mode is no item until it is reread', async () => {
    await setAcceptance('manual')
    await putRelease({ stage: 'awaiting-version', unreleased: 3, mode: 'trunk' }, 'manual')
    expect(await releaseIds()).toEqual([])
  })

  test('the title names the version that waits for acceptance', async () => {
    await putRelease({ stage: 'awaiting-version', unreleased: 3, next: '1.7.0' })
    const feed = await feedOf('releaser')
    expect(feed.mine[0]?.title).toBe('Changes wait for acceptance before version 1.7.0')
  })

  test('switching the setting to no acceptance drops the item at once, before the row is reread', async () => {
    await putRelease({ stage: 'awaiting-version', unreleased: 3, next: '1.7.0' })
    expect(await releaseIds()).toEqual(['release:work:acme/web-shop'])
    const response = await call('PUT', '/settings', as('admin'), {
      id: 'releases-all',
      key: 'releases',
      scope: { all: true },
      value: { enabled: true, acceptance: 'none' },
    })
    expect(response.status).toBe(200)
    const feed = await feedOf('releaser')
    expect([...feed.mine, ...feed.teams]).toEqual([])
    const count = (await (await call('GET', '/inbox/count', as('releaser'))).json()) as InboxCount
    expect(count.total).toBe(0)
  })

  test('turning releases off drops the item too', async () => {
    await putRelease({ stage: 'awaiting-version', unreleased: 3 })
    await store.settings.put({
      id: 'releases-all',
      key: 'releases',
      scope: { all: true },
      value: { enabled: false, acceptance: 'manual' },
      secret: false,
      updatedAt: '2026-10-01T00:00:00.000Z',
    })
    expect(await releaseIds()).toEqual([])
    const response = await call('GET', '/releases/overview?filter=action', as('releaser'))
    expect(((await response.json()) as ReleaseOverview).cards).toEqual([])
  })
})
