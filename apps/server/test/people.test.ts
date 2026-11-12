import { beforeEach, describe, expect, test } from 'bun:test'

import type { Action, LinkResponse, PeopleSummary, UserList, UserView } from '@holtkeeper/api'
import { adminGrants, createUser, issueUserLink, usersAuth } from '@holtkeeper/auth-users'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store, User } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'

const origin = 'https://keeper.test'

const config = parseConfig({
  forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => ({}) as never } },
  groups: {
    widgets: { forge: 'work', include: ['widgets/*'] },
    gadgets: { forge: 'work', include: ['gadgets/*'] },
  },
})

let store: Store
let clock: Date
beforeEach(() => {
  store = memoryStore()
  clock = new Date('2026-11-02T09:00:00.000Z')
})

const setup = () => {
  const vault = aesVault('v'.repeat(32))
  return createApp({
    config,
    auth: usersAuth({
      store: store.users,
      audit: store.audit,
      kv: store.kv,
      sessionSecret: 's'.repeat(32),
      origin,
      linkTtlHours: 1,
      now: () => clock,
    }),
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [],
    now: () => clock,
  })
}

async function json<T>(response: Response): Promise<T> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (await response.json()) as T
}

/** Signs `user` in through a single-use login link and returns the session cookie. */
async function signIn(app: ReturnType<typeof setup>, user: User): Promise<string> {
  const manage = { store: store.users, actor: 'cli', now: () => clock }
  const { link } = await issueUserLink(manage, { user, purpose: 'login', origin, ttlMs: 60_000 })
  const response = await app.request(link)
  expect(response.status).toBe(302)
  const [cookie = ''] = response.headers.getSetCookie()
  return cookie.split(';')[0] ?? ''
}

const send = (
  app: ReturnType<typeof setup>,
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
) =>
  app.request(`${origin}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const widgetGrant = { scope: { groups: ['widgets'] }, actions: ['repos:read' as const] }

async function adminSession(app: ReturnType<typeof setup>) {
  const admin = await createUser(
    { store: store.users, actor: 'cli', now: () => clock },
    { name: 'Widget Admin', grants: adminGrants },
  )
  return { admin, cookie: await signIn(app, admin) }
}

describe('people endpoints', () => {
  test('the user list carries invite, teams, creator and last sign-in', async () => {
    const app = setup()
    const { admin, cookie } = await adminSession(app)
    const invited = await json<LinkResponse>(
      await send(app, cookie, 'POST', '/auth/users/admin/users', {
        name: 'Gadget Dev',
        grants: [widgetGrant],
      }),
    )
    const { users } = await json<UserList>(
      await send(app, cookie, 'GET', '/auth/users/admin/users'),
    )
    const self = users.find((user) => user.id === admin.id)
    const pending = users.find((user) => user.id === invited.user.id)
    expect(self?.lastSeenAt).toBe('2026-11-02T09:00:00.000Z')
    expect(self?.creator).toBeUndefined()
    expect(self?.createdBy).toBe('cli')
    expect(pending?.invite).toMatchObject({ expired: false, createdBy: admin.id })
    expect(pending?.creator?.name).toBe('Widget Admin')
    expect(pending?.teams).toEqual(['widgets'])
  })

  test('teams follow the home groups a person picks in their preferences', async () => {
    const app = setup()
    const { cookie } = await adminSession(app)
    const dev = await createUser(
      { store: store.users, actor: 'cli', now: () => clock },
      { name: 'Gadget Dev', grants: [widgetGrant] },
    )
    const devCookie = await signIn(app, dev)
    const saved = await send(app, devCookie, 'PUT', '/api/me/preferences', {
      homeGroups: ['gadgets'],
    })
    expect(saved.status).toBe(200)
    const { users } = await json<UserList>(
      await send(app, cookie, 'GET', '/auth/users/admin/users'),
    )
    expect(users.find((user) => user.id === dev.id)?.teams).toEqual(['gadgets'])
  })

  test('the account shows who gave the access', async () => {
    const app = setup()
    const { cookie } = await adminSession(app)
    const invited = await json<LinkResponse>(
      await send(app, cookie, 'POST', '/auth/users/admin/users', {
        name: 'Gadget Dev',
        grants: [widgetGrant],
      }),
    )
    const user = await store.users.getUser(invited.user.id)
    if (!user) throw new Error('user missing')
    const account = await json<UserView>(
      await send(app, await signIn(app, user), 'GET', '/auth/users/me'),
    )
    expect(account.creator?.name).toBe('Widget Admin')
    expect(account.invite).toBeUndefined()
  })

  test('the summary counts people by state', async () => {
    const app = setup()
    const { cookie } = await adminSession(app)
    await send(app, cookie, 'POST', '/auth/users/admin/users', { name: 'Pending', grants: [] })
    const summary = await json<PeopleSummary>(
      await send(app, cookie, 'GET', '/auth/users/admin/summary'),
    )
    expect(summary).toMatchObject({ total: 2, active: 1, invited: 1, admins: 1, withoutSignIn: 2 })
    expect(summary.signIn).toEqual(['passkeys'])
  })

  test('sending an invite again issues a new link and is audited', async () => {
    const app = setup()
    const { cookie } = await adminSession(app)
    const invited = await json<LinkResponse>(
      await send(app, cookie, 'POST', '/auth/users/admin/users', {
        name: 'Gadget Dev',
        grants: [widgetGrant],
      }),
    )
    clock = new Date('2026-11-02T11:00:00.000Z')
    const before = await json<UserList>(await send(app, cookie, 'GET', '/auth/users/admin/users'))
    expect(before.users.find((user) => user.id === invited.user.id)?.invite?.expired).toBe(true)

    const response = await send(
      app,
      cookie,
      'POST',
      `/auth/users/admin/users/${invited.user.id}/invite`,
    )
    expect(response.status).toBe(201)
    const again = await json<LinkResponse>(response)
    expect(again.user.invite).toMatchObject({ expired: false, createdAt: clock.toISOString() })
    const { events } = await store.audit.list({ targetId: invited.user.id })
    expect(events.map((event) => event.request?.route)).toContain(
      '/auth/users/admin/users/:id/invite',
    )
  })

  test('a narrow grant sees and resends only within its own grants', async () => {
    const app = setup()
    await adminSession(app)
    const manage = { store: store.users, actor: 'cli', now: () => clock }
    const person = (name: string, group: string, actions: Action[]) =>
      createUser(manage, {
        name,
        grants: [{ scope: { groups: [group] }, actions }],
      })
    const widgetDev = await person('Widget Dev', 'widgets', ['repos:read'])
    const gadgetDev = await person('Gadget Dev', 'gadgets', ['repos:read'])
    const reader = await person('Widget Lead', 'widgets', ['repos:read', 'users:read'])
    const outsider = await person('Widget Viewer', 'widgets', ['repos:read'])
    const inviter = await person('Widget Inviter', 'widgets', [
      'repos:read',
      'users:read',
      'users:write',
      'users:invite',
    ])
    const writer = await person('Widget Writer', 'widgets', [
      'repos:read',
      'users:read',
      'users:write',
    ])

    const summary = await json<PeopleSummary>(
      await send(app, await signIn(app, reader), 'GET', '/auth/users/admin/summary'),
    )
    expect(summary).toMatchObject({ total: 3, admins: 0 })
    const none = await json<PeopleSummary>(
      await send(app, await signIn(app, outsider), 'GET', '/auth/users/admin/summary'),
    )
    expect(none.total).toBe(0)

    const inviterCookie = await signIn(app, inviter)
    const outside = await send(
      app,
      inviterCookie,
      'POST',
      `/auth/users/admin/users/${gadgetDev.id}/invite`,
    )
    expect(outside.status).toBe(404)
    const withoutInvite = await send(
      app,
      await signIn(app, writer),
      'POST',
      `/auth/users/admin/users/${widgetDev.id}/invite`,
    )
    expect(withoutInvite.status).toBe(403)
  })

  test('signed-in requests move lastSeenAt at most once a minute', async () => {
    const app = setup()
    const { admin, cookie } = await adminSession(app)
    await send(app, cookie, 'GET', '/api/me')
    clock = new Date('2026-11-02T09:00:30.000Z')
    await send(app, cookie, 'GET', '/api/me')
    expect((await store.users.getUser(admin.id))?.lastSeenAt).toBe('2026-11-02T09:00:00.000Z')
    clock = new Date('2026-11-02T09:01:30.000Z')
    await send(app, cookie, 'GET', '/api/me')
    expect((await store.users.getUser(admin.id))?.lastSeenAt).toBe('2026-11-02T09:01:30.000Z')
  })
})
