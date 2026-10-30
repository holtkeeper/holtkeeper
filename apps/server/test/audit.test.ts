import { beforeEach, describe, expect, test } from 'bun:test'

import type { Principal } from '@holtkeeper/access'
import type {
  AccountChallenge,
  AuditList,
  AuditVerifyResponse,
  CredentialView,
  ExternalAccountList,
  ExternalAccountView,
  MeResponse,
} from '@holtkeeper/api'
import type { AuthProvider } from '@holtkeeper/auth'
import { headerAuth } from '@holtkeeper/auth-header'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'
import { REDACTED, appendAudit, deriveAction, diffChanges } from '../src/audit.ts'
import { identitiesFor } from '../src/routes/accounts.ts'

const config = parseConfig({
  forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => ({}) as never } },
  groups: { games: { forge: 'work', include: ['games/*'] } },
})

let store: Store
const now = new Date('2026-10-30T12:00:00.000Z')
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
    now: () => now,
  })
}

const games = headerAuth({
  roles: {
    games: [{ scope: { groups: ['games'] }, actions: ['credentials:read', 'credentials:write'] }],
  },
})
const asGames = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'games' }

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

const events = async () => (await store.audit?.list({ limit: 100 }))?.events ?? []

beforeEach(() => {
  store = memoryStore()
})

const derive = (method: string, route: string, path: string, params = {}) =>
  deriveAction(method, route, path, params)

describe('audit helpers', () => {
  test('diffChanges compares nested fields and redacts secrets', () => {
    expect(
      diffChanges(
        { name: 'a', scope: { groups: ['x'] }, options: { headers: { authorization: 'k1' } } },
        { name: 'b', scope: { groups: ['x', 'y'] }, options: { headers: { authorization: 'k2' } } },
      ),
    ).toEqual([
      { field: 'name', before: 'a', after: 'b' },
      { field: 'options.headers.authorization', before: REDACTED, after: REDACTED },
      { field: 'scope.groups', before: ['x'], after: ['x', 'y'] },
    ])
    expect(diffChanges(undefined, { apiToken: 'x', n: 1 })).toEqual([
      { field: 'apiToken', after: REDACTED },
      { field: 'n', after: 1 },
    ])
    expect(diffChanges({ value: 's1' }, { value: 's2' }, { secret: (f) => f === 'value' })).toEqual(
      [{ field: 'value', before: REDACTED, after: REDACTED }],
    )
    expect(diffChanges({ a: 1, at: 'x' }, { a: 1, at: 'y' }, { ignore: ['at'] })).toEqual([])
  })

  test('deriveAction names actions and targets from route templates', () => {
    expect(derive('POST', '/api/credentials', '/api/credentials')).toEqual({
      action: 'credential.create',
      target: { type: 'credential' },
    })
    expect(derive('PATCH', '/api/credentials/:id', '/api/credentials/c1', { id: 'c1' })).toEqual({
      action: 'credential.update',
      target: { type: 'credential', id: 'c1' },
    })
    expect(
      derive('POST', '/api/credentials/:id/rotate', '/api/credentials/c1/rotate', { id: 'c1' })
        .action,
    ).toBe('credential.rotate')
    expect(
      derive('POST', '/api/knowledge/:id/:action{accept|reject}', '/api/knowledge/k/accept', {
        id: 'k',
        action: 'accept',
      }).action,
    ).toBe('knowledge.accept')
    expect(derive('POST', '/api/analyses', '/api/analyses').action).toBe('analysis.create')
    expect(
      derive(
        'DELETE',
        '/auth/users/admin/users/:id/passkeys/:passkeyId',
        '/auth/users/admin/users/u1/passkeys/p1',
        { id: 'u1', passkeyId: 'p1' },
      ),
    ).toEqual({ action: 'passkey.delete', target: { type: 'passkey', id: 'p1' } })
    expect(
      derive(
        'POST',
        '/auth/users/admin/users/:id/accounts',
        '/auth/users/admin/users/u1/accounts',
        {
          id: 'u1',
        },
      ),
    ).toEqual({ action: 'account.create', target: { type: 'user', id: 'u1' } })
  })

  test('appendAudit records webhook and job events and tolerates stores without a log', async () => {
    const event = await appendAudit(store, {
      actor: { id: 'gitlab:work:42', name: 'jane', provider: 'gitlab:work' },
      via: 'webhook',
      action: 'mr.policy.label',
      target: { type: 'merge-request', id: '7', repo: 'work:games/a' },
      outcome: 'ok',
    })
    expect(event).toMatchObject({ seq: 1, via: 'webhook' })
    expect(event?.at).toBeString()
    expect(
      await appendAudit(
        { audit: undefined },
        {
          actor: { id: 'system', name: 'scheduler', provider: 'job' },
          via: 'job',
          action: 'x',
          target: { type: 'job' },
          outcome: 'ok',
        },
      ),
    ).toBeUndefined()
  })
})

describe('audit middleware', () => {
  test('audits mutating API requests with route, params, status and redacted changes', async () => {
    const app = setup()
    const created = (await (
      await send(app, 'POST', '/api/credentials', {
        name: 'Bot',
        kind: 'other',
        url: 'https://gitlab.test',
        scope: { groups: ['games'] },
        secret: 'glpat-123',
      })
    ).json()) as CredentialView
    await send(app, 'PATCH', `/api/credentials/${created.id}`, {
      name: 'Bot 2',
      secret: 'glpat-456',
    })
    expect((await app.request('/api/credentials')).status).toBe(200)

    const [update, create] = await events()
    expect(create).toMatchObject({
      actor: { id: 'root', provider: 'none' },
      via: 'api',
      action: 'credential.create',
      target: { type: 'credential', id: created.id },
      outcome: 'ok',
      status: 201,
      request: { method: 'POST', path: '/api/credentials', route: '/api/credentials' },
    })
    expect(update).toMatchObject({
      action: 'credential.update',
      status: 200,
      request: { route: '/api/credentials/:id', params: { id: created.id } },
      changes: [
        { field: 'name', before: 'Bot', after: 'Bot 2' },
        { field: 'secret', before: REDACTED, after: REDACTED },
      ],
    })
    expect(typeof update?.request?.durationMs).toBe('number')
    expect(JSON.stringify(await events())).not.toContain('glpat')
    expect(await store.audit?.count()).toBe(2)
  })

  test('denied and failed requests are audited with their outcome', async () => {
    const app = setup(games)
    expect((await send(app, 'POST', '/api/accounts', {})).status).toBe(401)
    expect(
      (
        await send(
          app,
          'POST',
          '/api/credentials',
          { name: 'x', kind: 'other', url: 'https://x.test', scope: { all: true }, secret: 's' },
          { ...asGames, 'sec-fetch-site': 'same-origin', 'x-forwarded-for': '10.0.0.1, 10.0.0.2' },
        )
      ).status,
    ).toBe(403)
    expect((await send(app, 'DELETE', '/api/credentials/missing', undefined, asGames)).status).toBe(
      404,
    )
    const [missing, forbidden, anonymous] = await events()
    expect(anonymous).toMatchObject({
      actor: { id: 'anonymous', provider: 'header' },
      outcome: 'denied',
      status: 401,
    })
    expect(forbidden).toMatchObject({
      actor: { id: 'header:jane', provider: 'header' },
      via: 'ui',
      outcome: 'denied',
      status: 403,
      request: { ip: '10.0.0.1' },
    })
    expect(missing).toMatchObject({ outcome: 'error', status: 404, target: { id: 'missing' } })
  })

  test('secret setting values never reach the audit log', async () => {
    const app = setup()
    await send(app, 'PUT', '/api/settings', {
      key: 'llm.apiKey',
      scope: { all: true },
      value: 'sk-1',
    })
    await send(app, 'PUT', '/api/settings', { key: 'llm.model', scope: { all: true }, value: 'm1' })
    const [model, key] = await events()
    expect(key?.changes).toContainEqual({ field: 'value', after: REDACTED })
    expect(model?.changes).toContainEqual({ field: 'value', after: 'm1' })
    expect(model?.action).toBe('setting.create')
  })

  test('user changes through the auth provider get field-level changes', async () => {
    await store.users.putUser({
      id: 'u1',
      name: 'Ann',
      grants: [],
      disabled: false,
      sessionVersion: 1,
      createdAt: now.toISOString(),
    })
    const admin: Principal = {
      id: 'root',
      name: 'Root',
      provider: 'users',
      grants: [{ scope: { all: true }, actions: ['*'] }],
    }
    const users: AuthProvider = {
      name: 'users',
      authenticate: async () => admin,
      info: () => ({ provider: 'users', methods: [] }),
      async handle(request, path) {
        const user = await store.users.getUser('u1')
        if (request.method === 'PATCH' && path === '/admin/users/u1' && user) {
          await store.users.putUser({ ...user, name: 'Anna', disabled: true })
          return Response.json({})
        }
        return Response.json({}, { status: 201 })
      },
    }
    const app = setup(users)
    await send(app, 'PATCH', '/auth/users/admin/users/u1', { name: 'Anna' })
    await send(app, 'POST', '/auth/users/passkey/login/verify', {})
    const [event, ...rest] = await events()
    expect(rest).toEqual([])
    expect(event).toMatchObject({
      action: 'user.update',
      target: { type: 'user', id: 'u1' },
      request: { route: '/auth/users/admin/users/:id', params: { id: 'u1' } },
      changes: [
        { field: 'disabled', before: false, after: true },
        { field: 'name', before: 'Ann', after: 'Anna' },
      ],
    })
  })
})

describe('audit routes', () => {
  test('list, page, filter, count, export and verify need global audit:read', async () => {
    const app = setup()
    for (const name of ['a', 'b', 'c'])
      await send(app, 'PUT', '/api/settings', {
        key: 'llm.model',
        scope: { all: true },
        value: name,
      })
    await send(app, 'DELETE', '/api/settings/missing')

    const first = (await (await app.request('/api/audit?limit=2')).json()) as AuditList
    expect(first.events.map((e) => e.seq)).toEqual([4, 3])
    const second = (await (
      await app.request(`/api/audit?limit=2&cursor=${first.nextCursor}`)
    ).json()) as AuditList
    expect(second.events.map((e) => e.seq)).toEqual([2, 1])
    const errors = (await (await app.request('/api/audit?outcome=error')).json()) as AuditList
    expect(errors.events.map((e) => e.action)).toEqual(['setting.delete'])
    expect((await app.request('/api/audit?outcome=nope')).status).toBe(400)
    expect(await (await app.request('/api/audit/count?action=setting.create')).json()).toEqual({
      count: 3,
    })

    const ndjson = await app.request('/api/audit/export?format=ndjson&action=setting')
    expect(ndjson.headers.get('content-type')).toBe('application/x-ndjson')
    const lines = (await ndjson.text()).trimEnd().split('\n')
    expect(lines.map((line) => JSON.parse(line).seq)).toEqual([1, 2, 3, 4])
    const csv = await (await app.request('/api/audit/export?format=csv')).text()
    expect(csv.split('\n')[0]).toStartWith('seq,at,actor.id')
    expect((await app.request('/api/audit/export?format=xml')).status).toBe(400)
    const exports = (await (
      await app.request('/api/audit?action=audit.export')
    ).json()) as AuditList
    expect(exports.events).toHaveLength(2)

    const verified = (await (await app.request('/api/audit/verify')).json()) as AuditVerifyResponse
    expect(verified).toMatchObject({ ok: true, checked: 6 })
    expect((await app.request('/api/audit/verify?fromSeq=x')).status).toBe(400)

    const jane = setup(games)
    expect((await jane.request('/api/audit', { headers: asGames })).status).toBe(403)
    expect((await jane.request('/api/audit/export', { headers: asGames })).status).toBe(403)
  })
})

describe('avatars', () => {
  test('renders voxel-bot SVGs with long caching and ETags', async () => {
    const app = setup()
    const response = await app.request('/api/avatars/alice.svg?size=64')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/svg+xml')
    expect(response.headers.get('cache-control')).toContain('immutable')
    const svg = await response.text()
    expect(svg).toStartWith('<svg')
    expect(svg).toContain('width="64"')
    const etag = response.headers.get('etag') ?? ''
    expect(etag).toMatch(/^"[0-9a-f]{40}"$/)

    const again = await app.request('/api/avatars/alice.svg?size=64')
    expect(await again.text()).toBe(svg)
    const notModified = await app.request('/api/avatars/alice.svg?size=64', {
      headers: { 'if-none-match': etag },
    })
    expect(notModified.status).toBe(304)
    const other = await app.request('/api/avatars/bob.svg?size=64')
    expect(other.headers.get('etag')).not.toBe(etag)

    expect((await app.request('/api/avatars/alice.png')).status).toBe(404)
    expect((await app.request('/api/avatars/alice.svg?size=4')).status).toBe(400)
    expect((await app.request(`/api/avatars/${'x'.repeat(200)}.svg`)).status).toBe(400)
  })

  test('/api/me carries the avatar URL; user accounts can reroll their seed', async () => {
    const me = (await (await setup().request('/api/me')).json()) as MeResponse
    expect(me.principal?.avatarUrl).toBe('/api/avatars/root.svg')
    expect((await send(setup(), 'PUT', '/api/me/avatar', { seed: 'x' })).status).toBe(409)

    await store.users.putUser({
      id: 'u1',
      name: 'Ann',
      grants: [],
      disabled: false,
      sessionVersion: 1,
      createdAt: now.toISOString(),
    })
    const ann: AuthProvider = {
      name: 'users',
      authenticate: async () => ({ id: 'u1', name: 'Ann', provider: 'users', grants: [] }),
      info: () => ({ provider: 'users', methods: [] }),
    }
    const app = setup(ann)
    const set = await send(app, 'PUT', '/api/me/avatar', { seed: 'lucky 7' })
    expect(((await set.json()) as MeResponse['principal'])?.avatarUrl).toBe(
      '/api/avatars/lucky%207.svg',
    )
    expect((await store.users.getUser('u1'))?.avatarSeed).toBe('lucky 7')
    expect((await app.request('/api/avatars/lucky%207.svg')).status).toBe(200)
    await send(app, 'PUT', '/api/me/avatar', { seed: null })
    expect((await store.users.getUser('u1'))?.avatarSeed).toBeUndefined()
    const [reset] = await events()
    expect(reset).toMatchObject({
      action: 'user.avatar',
      changes: [{ field: 'avatarSeed', before: 'lucky 7' }],
    })
  })
})

describe('external accounts', () => {
  test('link, challenge, verify through the service and resolve the actor', async () => {
    const app = setup()
    const created = await send(app, 'POST', '/api/accounts', {
      provider: 'gitlab:work',
      externalId: '42',
      username: 'root',
    })
    expect(created.status).toBe(201)
    const account = (await created.json()) as ExternalAccountView
    expect(account.verification).toBe('unverified')
    expect(
      (await send(app, 'POST', '/api/accounts', { provider: 'gitlab:work', externalId: 'x' }))
        .status,
    ).toBe(400)

    const challenge = (await (
      await send(app, 'POST', `/api/accounts/${account.id}/challenge`)
    ).json()) as AccountChallenge
    expect(challenge.command).toBe(`/holtkeeper verify ${challenge.code}`)
    const listed = (await (await app.request('/api/accounts')).json()) as ExternalAccountList
    expect(listed.accounts[0]?.challengeExpiresAt).toBe(challenge.expiresAt)
    expect(JSON.stringify(listed)).not.toContain('hash')

    const identities = identitiesFor({ store, now: () => now })
    expect(
      await identities?.resolveExternalActor({ provider: 'gitlab:work', externalId: '42' }),
    ).toBeUndefined()
    const done = await identities?.completeChallenge({
      provider: 'gitlab:work',
      externalId: '42',
      code: challenge.code,
    })
    expect(done?.ok).toBe(true)
    expect(
      await identities?.authorizeExternal({
        provider: 'gitlab:work',
        externalId: '42',
        action: 'analyses:run',
        repo: { forge: 'work', path: 'games/a', groups: ['games'] },
      }),
    ).toMatchObject({ allowed: true, principal: { id: 'root', provider: 'none' } })

    expect((await send(app, 'POST', `/api/accounts/${account.id}/challenge`)).status).toBe(409)
    expect((await send(app, 'DELETE', '/api/accounts/missing')).status).toBe(404)
    expect((await send(app, 'DELETE', `/api/accounts/${account.id}`)).status).toBe(204)
    const actions = (await events()).map((e) => e.action)
    expect(actions).toEqual([
      'account.unlink',
      'account.delete',
      'account.challenge',
      'account.verify',
      'account.challenge',
      'account.create',
      'account.link',
    ])
  })

  test('anonymous callers cannot manage accounts', async () => {
    expect((await setup(games).request('/api/accounts')).status).toBe(401)
  })
})
