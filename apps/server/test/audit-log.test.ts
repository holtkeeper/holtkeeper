import { beforeEach, describe, expect, test } from 'bun:test'

import type { Action, Scope } from '@holtkeeper/access'
import type { AuditVerifyLast, HistorySummary } from '@holtkeeper/api'
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
import { verifyAuditChainIfDue } from '../src/audit-verify.ts'
import { appendAudit } from '../src/audit.ts'

const config = parseConfig({
  forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => ({}) as never } },
  groups: { widgets: { forge: 'work', include: ['widgets/*'] } },
})

const now = new Date('2026-11-12T12:00:00.000Z')
let store: Store

beforeEach(() => {
  store = memoryStore()
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
    now: () => now,
  })
}

const narrow = (actions: Action[], scope: Scope = { groups: ['widgets'] }) =>
  setup(headerAuth({ roles: { widgets: [{ scope, actions }] } }))
const asWidgets = { 'x-forwarded-user': 'ann', 'x-forwarded-groups': 'widgets' }

const append = (at: string, action: string, repo?: string, actor = 'u1') =>
  appendAudit(store, {
    at,
    actor: { id: actor, name: actor, provider: 'users' },
    via: 'ui',
    action,
    target: { type: action.split('.')[0] ?? 'x', ...(repo && { repo }) },
    outcome: 'ok',
  })

const seed = async () => {
  await append('2026-11-10T09:00:00.000Z', 'release.cut', 'work:widgets/gear')
  await append('2026-11-11T09:00:00.000Z', 'setting.update', 'work:other/bolt')
  await append('2026-11-11T10:00:00.000Z', 'credential.create')
  await append('2026-11-12T09:00:00.000Z', 'release.cut', 'work:widgets/cog', 'bot')
}

const summary = async (app: ReturnType<typeof setup>, query = '', headers = {}) =>
  (await (await app.request(`/api/history/summary${query}`, { headers })).json()) as HistorySummary

describe('GET /api/history/summary', () => {
  test('counts every event with global audit:read, with the history filters', async () => {
    await seed()
    const app = setup()
    const all = await summary(app)
    expect(all.total).toBe(4)
    expect(all.days).toEqual([
      { key: '2026-11-10', count: 1 },
      { key: '2026-11-11', count: 2 },
      { key: '2026-11-12', count: 1 },
    ])
    expect(all.actions[0]).toEqual({ key: 'release.cut', count: 2 })
    expect(all.repos.map((repo) => repo.key)).toEqual([
      'work:other/bolt',
      'work:widgets/cog',
      'work:widgets/gear',
    ])
    expect((await summary(app, '?action=release&from=2026-11-11T00:00:00.000Z')).total).toBe(1)
    expect((await summary(app, '?repos=work:other/bolt')).total).toBe(1)
    expect((await app.request('/api/history/summary?outcome=nope')).status).toBe(400)
  })

  test('narrows repos:read callers to readable repositories without instance events', async () => {
    await seed()
    const reader = narrow(['repos:read'])
    const seen = await summary(reader, '', asWidgets)
    expect(seen.total).toBe(2)
    expect(seen.repos.map((repo) => repo.key)).toEqual(['work:widgets/cog', 'work:widgets/gear'])
    expect(seen.actions).toEqual([{ key: 'release.cut', count: 2 }])
    expect(seen.actors.map((actor) => actor.key)).toEqual(['bot', 'u1'])
    expect((await summary(reader, '?repos=work:other/bolt', asWidgets)).total).toBe(0)
    expect(
      (await summary(reader, '?repos=work:widgets/gear,work:other/bolt', asWidgets)).total,
    ).toBe(1)
  })

  test('a global repos:read still sees no instance events', async () => {
    await seed()
    const reader = narrow(['repos:read'], { all: true })
    const seen = await summary(reader, '', asWidgets)
    expect(seen.total).toBe(3)
    expect(seen.actions.map((action) => action.key)).not.toContain('credential.create')
  })

  test('refuses callers without repos:read or audit:read', async () => {
    const response = await narrow(['settings:read']).request('/api/history/summary', {
      headers: asWidgets,
    })
    expect(response.status).toBe(403)
  })
})

describe('daily chain check', () => {
  test('is kept once a day and served by GET /api/audit/verify/last', async () => {
    await seed()
    const app = setup()
    expect(await (await app.request('/api/audit/verify/last')).json()).toEqual({})

    expect(await verifyAuditChainIfDue(store, now)).toBeTrue()
    const last = (await (await app.request('/api/audit/verify/last')).json()) as AuditVerifyLast
    expect(last).toEqual({
      at: now.toISOString(),
      result: { ok: true, checked: 4, firstSeq: 1, lastSeq: 4 },
    })
    const [event] = (await store.audit.list({ action: 'audit.verify' })).events
    expect(event).toMatchObject({ via: 'system', outcome: 'ok', actor: { id: 'system' } })

    expect(await verifyAuditChainIfDue(store, new Date('2026-11-13T11:00:00.000Z'))).toBeFalse()
    expect(await verifyAuditChainIfDue(store, new Date('2026-11-13T12:00:00.000Z'))).toBeTrue()
    const next = (await (await app.request('/api/audit/verify/last')).json()) as AuditVerifyLast
    expect(next.result).toMatchObject({ ok: true, checked: 5 })
  })

  test('the last check is only for global audit:read', async () => {
    await verifyAuditChainIfDue(store, now)
    const response = await narrow(['repos:read', 'audit:read']).request('/api/audit/verify/last', {
      headers: asWidgets,
    })
    expect(response.status).toBe(403)
  })
})
