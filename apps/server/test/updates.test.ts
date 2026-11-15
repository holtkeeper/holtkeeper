import { beforeEach, describe, expect, test } from 'bun:test'

import type { FleetListingView, RepoUpdatesView } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import type { GitForge, MergeRequestRecord, WebhookSpec } from '@holtkeeper/forge'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { pollingSetting } from '@holtkeeper/updates'
import { aesVault } from '@holtkeeper/vault'
import { z } from 'zod'

import { createApp } from '../src/app.ts'
import type { ServerDeps } from '../src/context.ts'
import { createEventDispatcher } from '../src/events.ts'
import { serverPoller } from '../src/updates.ts'

const HEAD = 'c'.repeat(40)
const NEXT = 'd'.repeat(40)

let store: Store
let mergeRequests: MergeRequestRecord[]
let registered: WebhookSpec[]
let removed: string[]
let now: Date
let visible: boolean

const fakeForge = {
  kind: 'gitlab',
  getRepository: async (path: string) => {
    if (!visible) throw new Error('404 Project Not Found')
    return { path, name: path, defaultBranch: 'main', webUrl: '', cloneUrl: '', archived: false }
  },
  listMergeRequests: async () => mergeRequests,
  listPipelines: async () => [],
  listTags: async () => [],
  listDiscussions: async () => [],
  ensureWebhook: async (_target: unknown, hook: WebhookSpec) => {
    registered.push(hook)
    const id = String(registered.length)
    return { id, hooks: [{ id, scope: 'project', target: 'games/a' }] }
  },
  removeWebhook: async (hooks: { id: string }[]) => {
    removed.push(...hooks.map((h) => h.id))
  },
} as unknown as GitForge

const config = parseConfig({
  forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => fakeForge } },
  teams: { games: { owns: ['work:games/a'] } },
  jobs: { onMergeRequest: { analyzers: ['review'] } },
})

const mr = (patch: Partial<MergeRequestRecord> = {}): MergeRequestRecord => ({
  id: 7,
  title: 'Add pricing',
  description: '',
  sourceBranch: 'pricing',
  targetBranch: 'main',
  state: 'open',
  draft: false,
  labels: [],
  author: 'jane',
  webUrl: '',
  createdAt: '2026-10-30T10:00:00Z',
  updatedAt: '2026-10-30T10:00:00Z',
  headSha: HEAD,
  ...patch,
})

const as = (role: string) => ({ 'x-forwarded-user': role, 'x-forwarded-groups': role })

const deps = (): ServerDeps => {
  const vault = aesVault('v'.repeat(32))
  return {
    config,
    auth: noAuth(),
    store,
    vault,
    credentials: createCredentialService({
      credentials: store.credentials,
      vault,
    }),
    settings: [...builtinSettings, pollingSetting],
    analyses: [],
    analyzers: [{ kind: 'review', scope: 'repo', options: z.object({ mergeRequest: z.number() }) }],
    now: () => now,
  }
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const mergeRequestHook = (path: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-gitlab-event': 'Merge Request Hook' },
  body: JSON.stringify({
    object_kind: 'merge_request',
    user: { username: 'jane' },
    project: { path_with_namespace: path, web_url: `https://gitlab.test/${path}` },
    object_attributes: { iid: 7, action: 'open', state: 'opened', last_commit: { id: HEAD } },
  }),
})

beforeEach(() => {
  store = memoryStore()
  mergeRequests = [mr()]
  registered = []
  removed = []
  now = new Date('2026-10-30T12:00:00.000Z')
  visible = true
})

describe('repository webhook', () => {
  test('issues a URL that queues jobs for its repository only', async () => {
    const app = createApp(deps())
    const created = await app.request('/api/repos/updates/webhook', json({ repo: 'work:games/a' }))
    expect(created.status).toBe(201)
    const view = (await created.json()) as RepoUpdatesView
    const url = view.webhook?.url ?? ''
    expect(url).toMatch(/\/api\/webhooks\/r\/[\w-]{32}$/)

    const path = new URL(url).pathname
    expect((await app.request(path, mergeRequestHook('games/other'))).status).toBe(400)
    const delivered = await app.request(path, mergeRequestHook('games/a'))
    expect(delivered.status).toBe(202)
    expect((await store.jobs.list({})).map((job) => job.analyzer)).toEqual(['review'])

    const after = (await (
      await app.request('/api/repos/updates?repo=work:games/a')
    ).json()) as RepoUpdatesView
    expect(after.viaWebhook).toBe(true)
    expect(after.webhook?.createdBy).toEqual({ id: 'root', name: 'root' })
    expect(after.webhook?.deliveries24h).toEqual({ total: 2, failed: 1 })
    expect(after.webhook?.deliveries).toEqual([
      {
        at: now.toISOString(),
        event: 'Merge Request Hook',
        summary: 'merge request !7 open',
        enqueued: 1,
        durationMs: 0,
      },
      {
        at: now.toISOString(),
        event: 'Merge Request Hook',
        enqueued: 0,
        error: 'this webhook belongs to another repository',
        durationMs: 0,
      },
    ])
  })

  test('keeps the last 50 deliveries and counts only the last day', async () => {
    const app = createApp(deps())
    const view = (await (
      await app.request('/api/repos/updates/webhook', json({ repo: 'work:games/a' }))
    ).json()) as RepoUpdatesView
    const path = new URL(view.webhook?.url ?? '').pathname
    for (let index = 0; index < 52; index += 1) {
      now = new Date(now.getTime() + 3_600_000)
      // oxlint-disable-next-line no-await-in-loop -- deliveries arrive one after another
      await app.request(path, mergeRequestHook('games/a'))
    }
    const after = (await (
      await app.request('/api/repos/updates?repo=work:games/a')
    ).json()) as RepoUpdatesView
    expect(after.webhook?.deliveries).toHaveLength(50)
    expect(after.webhook?.deliveries[0]?.at).toBe(now.toISOString())
    expect(after.webhook?.deliveries24h).toEqual({ total: 24, failed: 0 })
  })

  test('rotating invalidates the old URL and re-registers the hook on the forge', async () => {
    const app = createApp(deps())
    const first = (await (
      await app.request(
        '/api/repos/updates/webhook',
        json({ repo: 'work:games/a', register: true }),
      )
    ).json()) as RepoUpdatesView
    expect(registered).toHaveLength(1)
    const second = (await (
      await app.request('/api/repos/updates/webhook', json({ repo: 'work:games/a' }))
    ).json()) as RepoUpdatesView
    expect(second.webhook?.url).not.toBe(first.webhook?.url)
    expect(removed).toEqual(['1'])
    expect(registered.map((hook) => hook.url)).toEqual([
      first.webhook?.url ?? '',
      second.webhook?.url ?? '',
    ])

    const oldPath = new URL(first.webhook?.url ?? '').pathname
    expect((await app.request(oldPath, mergeRequestHook('games/a'))).status).toBe(404)

    const off = await app.request('/api/repos/updates/webhook?repo=work:games/a', {
      method: 'DELETE',
    })
    expect(off.status).toBe(204)
    expect(removed).toEqual(['1', '2'])
  })
})

describe('polling', () => {
  test('finds new commits on its schedule and queues what the trigger asks for', async () => {
    await store.settings.put({
      id: 'polling-a',
      key: 'polling',
      scope: { repos: ['work:games/a'] },
      value: { enabled: true, interval: '1m' },
      secret: false,
      updatedAt: now.toISOString(),
    })
    const serverDeps = deps()
    const poller = serverPoller(serverDeps, createEventDispatcher(serverDeps))
    if (!poller) throw new Error('expected a poller')

    await poller.tick()
    now = new Date(now.getTime() + 61_000)
    await poller.tick()
    expect((await poller.status({ forge: 'work', path: 'games/a' })).state.cursor).toBeDefined()
    expect(await store.jobs.list({})).toEqual([])

    mergeRequests = [mr({ updatedAt: '2026-10-30T12:00:30Z', headSha: NEXT })]
    now = new Date(now.getTime() + 61_000)
    await poller.tick()
    const jobs = await store.jobs.list({})
    expect(jobs).toMatchObject([
      { analyzer: 'review', ref: NEXT, trigger: 'poll', options: { mergeRequest: 7 } },
    ])
    const view = (await (
      await createApp(serverDeps).request('/api/repos/updates?repo=work:games/a')
    ).json()) as RepoUpdatesView
    expect(view.polling.attempts.map((a) => [a.trigger, a.events, a.enqueued])).toEqual([
      ['scheduled', 1, 1],
      ['scheduled', 0, 0],
    ])
  })

  test('a fleet can be listed again by hand, and its attempts are kept', async () => {
    visible = false
    const app = createApp(deps())
    const failed = (await (
      await app.request('/api/repos/updates/fleet/work/list', { method: 'POST' })
    ).json()) as FleetListingView
    expect(failed.repos).toEqual([])
    expect(failed.attempts[0]).toMatchObject({ trigger: 'manual', error: '404 Project Not Found' })

    visible = true
    now = new Date(now.getTime() + 1000)
    const listed = (await (
      await app.request('/api/repos/updates/fleet/work/list', { method: 'POST' })
    ).json()) as FleetListingView
    expect(listed).toMatchObject({ forge: 'work', patterns: ['games/a'] })
    expect(listed.repos).toEqual([{ forge: 'work', path: 'games/a' }])
    expect(listed.attempts.map((a) => a.repos ?? a.error)).toEqual([1, '404 Project Not Found'])

    const shown = (await (
      await app.request('/api/repos/updates/fleet/work')
    ).json()) as FleetListingView
    expect(shown.listedAt).toBe(now.toISOString())
    expect(shown.nextAt).toBe(new Date(now.getTime() + 30 * 60_000).toISOString())
    expect((await app.request('/api/repos/updates/fleet/nope')).status).toBe(404)
    expect(
      (await app.request('/api/repos/updates/fleet/nope/list', { method: 'POST' })).status,
    ).toBe(404)
  })

  test('a listing keeps what fleet patterns matched before the forge excludes', async () => {
    const listed = [
      { path: 'games/a', archived: false },
      { path: 'games/old', archived: false },
      { path: 'tools/x', archived: false },
    ]
    const listingForge = {
      ...fakeForge,
      listRepositories: async function* () {
        yield* listed
      },
    } as unknown as GitForge
    const fleetConfig = parseConfig({
      forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => listingForge } },
      fleet: { work: { exclude: ['games/old'] } },
      teams: { games: { owns: ['work:games/*'] } },
    })
    const app = createApp({ ...deps(), config: fleetConfig })
    const before = (await (
      await app.request('/api/repos/updates/fleet/work')
    ).json()) as FleetListingView
    expect(before).toMatchObject({ repos: [], matched: [], attempts: [] })
    expect(before.nextAt).toBeUndefined()

    const view = (await (
      await app.request('/api/repos/updates/fleet/work/list', { method: 'POST' })
    ).json()) as FleetListingView
    expect(view.repos).toEqual([{ forge: 'work', path: 'games/a' }])
    expect(view.matched).toEqual([
      { forge: 'work', path: 'games/a' },
      { forge: 'work', path: 'games/old' },
    ])
  })

  test('a fleet lists every namespace of the forge once: its includes and every team pattern', async () => {
    const listings: string[] = []
    const listingForge = {
      ...fakeForge,
      listRepositories: async function* (namespace: string) {
        listings.push(namespace)
        yield* [
          { path: `${namespace}/circle`, archived: false },
          { path: `${namespace}/oval`, archived: false },
          { path: `${namespace}/stale`, archived: true },
        ]
      },
    } as unknown as GitForge
    const overlapping = parseConfig({
      forges: {
        work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => listingForge },
        other: { kind: 'gitlab', url: 'https://other.test', create: () => listingForge },
      },
      fleet: { work: { include: ['tools/*'] } },
      teams: {
        shapes: { owns: ['work:shapes/*'], exclude: ['work:shapes/oval'] },
        round: { owns: ['work:shapes/circle'], consumes: ['work:paints/*'] },
      },
    })
    const serverDeps = { ...deps(), config: overlapping }
    const poller = serverPoller(serverDeps, createEventDispatcher(serverDeps))
    const listing = await poller?.listFleet('work')
    expect(listings.toSorted()).toEqual(['paints', 'shapes', 'tools'])
    // A team exclude only narrows ownership: the repository stays in the fleet.
    expect(listing?.repos.map((repo) => repo.path)).toEqual([
      'paints/circle',
      'paints/oval',
      'shapes/circle',
      'shapes/oval',
      'tools/circle',
      'tools/oval',
    ])

    const other = await poller?.listFleet('other')
    expect(other?.repos).toEqual([])
    expect(listings).toHaveLength(3)
  })

  test('only global settings rights reach a fleet listing; team rights do not', async () => {
    const listings: string[] = []
    const listingForge = {
      ...fakeForge,
      listRepositories: async function* (namespace: string) {
        listings.push(namespace)
        yield* [{ path: 'shapes/circle', archived: false }]
      },
    } as unknown as GitForge
    const shapes = parseConfig({
      forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => listingForge } },
      teams: {
        shapes: { owns: ['work:shapes/*'], members: [{ id: 'header:mia', role: 'maintainer' }] },
      },
    })
    const auth = headerAuth({
      roles: {
        lead: [{ scope: { teams: ['shapes'] }, actions: ['settings:read', 'settings:write'] }],
        reader: [{ scope: { all: true }, actions: ['settings:read'] }],
        admin: [{ scope: { all: true }, actions: ['settings:read', 'settings:write'] }],
      },
    })
    const app = createApp({ ...deps(), auth, config: shapes })
    const list = (headers: Record<string, string>) =>
      app.request('/api/repos/updates/fleet/work/list', { method: 'POST', headers })
    const read = (headers: Record<string, string>) =>
      app.request('/api/repos/updates/fleet/work', { headers })

    for (const headers of [as('lead'), { 'x-forwarded-user': 'mia' }, as('reader')]) {
      // oxlint-disable-next-line no-await-in-loop -- one caller after another
      expect((await list(headers)).status).toBe(403)
    }
    expect(listings).toEqual([])
    expect((await read(as('lead'))).status).toBe(403)
    expect((await read({ 'x-forwarded-user': 'mia' })).status).toBe(403)

    expect((await list(as('admin'))).status).toBe(200)
    expect(listings).toEqual(['shapes'])
    const view = (await (await read(as('reader'))).json()) as FleetListingView
    expect(view.repos).toEqual([{ forge: 'work', path: 'shapes/circle' }])
    expect(view.matched).toBeUndefined()
    expect(view.attempts).toHaveLength(1)
  })
})
