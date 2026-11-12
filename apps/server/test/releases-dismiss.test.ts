import { beforeEach, describe, expect, test } from 'bun:test'

import type { Principal } from '@holtkeeper/access'
import type { ReleaseOverview } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { releaseSettingsDefinition } from '@holtkeeper/release'
import { FakeForge } from '@holtkeeper/release/testing'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'
import { createEventDispatcher } from '../src/events.ts'
import { releaseCan, releaseServiceFor } from '../src/releases.ts'

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['releases:read', 'releases:run'] }],
    viewer: [{ scope: { all: true }, actions: ['releases:read'] }],
    games: [{ scope: { groups: ['games'] }, actions: ['releases:read', 'releases:run'] }],
    elsewhere: [
      { scope: { all: true }, actions: ['releases:read'] },
      { scope: { groups: ['tools'] }, actions: ['releases:run'] },
    ],
  },
})
const as = (groups: string, user = groups) => ({
  'x-forwarded-user': user,
  'x-forwarded-groups': groups,
})

let fake: FakeForge
let store: Store
let deps: Parameters<typeof createApp>[0]
let app: ReturnType<typeof createApp>
let background: Promise<unknown>[]

beforeEach(async () => {
  fake = new FakeForge()
  fake.commitTo('main', 'feat: [ABC-1] first widget')
  fake.tag('v1.0.0')
  fake.commitTo('development', 'feat: [ABC-2] gadgets')
  background = []
  store = memoryStore()
  const vault = aesVault('v'.repeat(32))
  deps = {
    config: parseConfig({
      forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => fake.forge } },
      groups: { games: { forge: 'work', include: ['g/app'] } },
    }),
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: [...builtinSettings, releaseSettingsDefinition],
    analyses: [],
    now: () => new Date('2026-11-01T09:00:00.000Z'),
    releasePollMs: 1,
    releaseRefreshDelayMs: 0,
    onBackground: (work) => {
      background.push(work)
    },
  }
  await store.settings.put({
    id: 'releases',
    key: 'releases',
    scope: { all: true },
    value: { enabled: true, acceptance: 'manual' },
    secret: false,
    updatedAt: '2026-10-01T00:00:00.000Z',
  })
  app = createApp(deps)
})

const repo = 'work:g/app'

const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(`/api${path}`, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const cardOf = async (headers = as('admin'), query = '') =>
  ((await (await call('GET', `/releases/overview${query}`, headers)).json()) as ReleaseOverview)
    .cards[0]

const push = async (branch: string) => {
  await createEventDispatcher(deps)(
    {
      kind: 'push',
      repo: { forge: 'work', path: 'g/app' },
      branch,
      sha: fake.branches.get(branch)!,
      actor: 'dev',
    },
    { actor: 'webhook:gitlab', via: 'webhook' },
  )
  await Promise.all(background)
}

describe('release card permissions', () => {
  test('offers steps only to holders of releases:run on the repository', async () => {
    expect((await cardOf())?.can).toEqual({ accept: false, run: true })
    expect((await cardOf(as('games')))?.can).toEqual({ accept: false, run: true })
    expect((await cardOf(as('viewer')))?.can).toEqual({ accept: false, run: false })
    expect((await cardOf(as('elsewhere')))?.can).toEqual({ accept: false, run: false })
  })

  test('offers Accept while the target branch waits for a version and nobody accepted it', async () => {
    fake.commitTo('main', 'fix: [ABC-3] crash')
    await push('main')
    expect(await cardOf()).toMatchObject({
      stage: 'awaiting-version',
      head: fake.branches.get('main'),
      can: { accept: true, run: true },
    })
    expect((await cardOf(as('elsewhere')))?.can).toEqual({ accept: false, run: false })

    expect((await call('POST', '/releases/accept', as('admin'), { repo })).status).toBe(200)
    await Promise.all(background)
    expect((await cardOf())?.can).toEqual({ accept: false, run: true })
  })

  test('computes can per principal over one snapshot', async () => {
    await cardOf()
    const service = releaseServiceFor(deps)
    const [card] = await service.snapshot()
    expect(card?.can).toEqual({ accept: false, run: false })
    const narrow: Principal = {
      id: 'header:kim',
      name: 'Kim',
      provider: 'header',
      grants: [{ scope: { groups: ['tools'] }, actions: ['releases:run'] }],
    }
    const wide: Principal = {
      ...narrow,
      grants: [{ scope: { repos: [repo] }, actions: ['releases:run'] }],
    }
    expect(releaseCan(deps.config, narrow, card!)).toEqual({ accept: false, run: false })
    expect(releaseCan(deps.config, wide, card!)).toEqual({ accept: false, run: true })
    expect(releaseCan(deps.config, wide, { ...card!, unreleased: 2 }).accept).toBe(true)
    expect(releaseCan(deps.config, wide, { ...card!, unreleased: 2, error: 'boom' }).accept).toBe(
      false,
    )
  })
})

describe('dismissing a waiting release', () => {
  test('hides it until a new commit, in the key-value store only', async () => {
    const before = await cardOf()
    const head = fake.branches.get('development')!
    expect(before).toMatchObject({ stage: 'candidate', head, needsAction: true })

    const reads = fake.listedCommits
    const calls = fake.calls.length
    const response = await call('POST', '/releases/dismiss', as('admin', 'jane'), {
      repo,
      sha: head,
    })
    expect(response.status).toBe(200)
    expect(fake.listedCommits).toBe(reads)
    expect(fake.calls.length).toBe(calls)

    const dismissed = await cardOf()
    expect(dismissed).toMatchObject({
      needsAction: false,
      dismissed: { sha: head, by: 'header:jane', at: '2026-11-01T09:00:00.000Z' },
    })
    expect(dismissed!.dismissed).toBeDefined()
    expect(await cardOf(as('admin'), '?filter=action')).toBeUndefined()
    expect((await releaseServiceFor(deps).snapshot())[0]!.dismissed).toBeDefined()

    const events = (await store.audit.list({ action: 'release.dismiss' })).events
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      actor: { id: 'header:jane' },
      target: { type: 'release', repo },
      outcome: 'ok',
      details: { sha: head },
    })

    fake.commitTo('development', 'feat: [ABC-4] settings')
    await push('development')
    const again = await cardOf()
    expect(again).toMatchObject({ head: fake.branches.get('development'), needsAction: true })
    expect(again?.dismissed).toBeUndefined()
  })

  test('refuses a narrow grant and a head that moved', async () => {
    await cardOf()
    const head = fake.branches.get('development')!
    const denied = await Promise.all(
      ['viewer', 'elsewhere'].map(async (role) =>
        call('POST', '/releases/dismiss', as(role), { repo, sha: head }),
      ),
    )
    expect(denied.map((response) => response.status)).toEqual([403, 403])
    expect(
      (await call('POST', '/releases/dismiss', as('admin'), { repo, sha: 'f'.repeat(40) })).status,
    ).toBe(409)
    expect((await call('POST', '/releases/dismiss', as('admin'), { repo })).status).toBe(400)
    expect((await cardOf())?.dismissed).toBeUndefined()
    expect((await store.audit.list({ action: 'release.dismiss' })).events).toEqual([])
  })
})
