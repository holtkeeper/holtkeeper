import { beforeEach, describe, expect, test } from 'bun:test'

import type { Scope } from '@holtkeeper/access'
import type { CredentialList, IntegrationForgeList } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { type CredentialService, createCredentialService } from '@holtkeeper/credentials'
import type { GitForge } from '@holtkeeper/forge'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'

const config = parseConfig({
  forges: {
    work: {
      kind: 'gitlab',
      url: 'https://forge.example.test',
      create: () => ({ kind: 'gitlab' }) as unknown as GitForge,
    },
  },
  groups: {
    web: { forge: 'work', include: ['acme/widget-kit', 'acme/storefront'] },
    pay: { forge: 'work', include: ['acme/ledger-api'] },
  },
  jobs: { webhooks: { work: { secret: 'widget-hook' } } },
})

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['*'] }],
    narrow: [
      {
        scope: { groups: ['web'] },
        actions: ['settings:read', 'credentials:read', 'credentials:write'],
      },
    ],
  },
})
const as = (role: string) => ({ 'x-forwarded-user': role, 'x-forwarded-groups': role })

const vault = aesVault('v'.repeat(32))
let store: Store
let credentials: CredentialService
let at: number

const appOf = () =>
  createApp({
    config,
    auth,
    store,
    vault,
    credentials,
    settings: builtinSettings,
    analyses: [],
    now: () => new Date(at),
  })

const call = (
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
  extra: Record<string, string> = {},
) =>
  appOf().request(`/api${path}`, {
    method,
    headers: { ...headers, ...extra, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const created = (name: string, kind: string, scope: Scope = { all: true }) =>
  credentials.create({
    name,
    kind,
    url: 'https://forge.example.test',
    scope,
    secret: `${name}-secret`,
  })

beforeEach(() => {
  store = memoryStore()
  at = Date.parse('2026-11-12T10:00:00.000Z')
  credentials = createCredentialService({
    credentials: store.credentials,
    vault,
    now: () => new Date(at),
  })
})

describe('GET /api/credentials', () => {
  test('names what uses each credential and when it was last used', async () => {
    const forgeToken = await created('widget-bot', 'gitlab')
    const reader = await created('gadget-reader', 'github')
    const proxy = await created('proxy-secret', 'egress-secret')
    const idle = await created('spare-key', 'other')
    const provider = await created('main-gateway', 'anthropic-compatible')
    await store.config?.put({
      type: 'forge',
      id: 'work',
      updatedAt: '2026-11-01T00:00:00.000Z',
      data: { kind: 'gitlab', url: 'https://forge.example.test', credentialId: forgeToken.id },
    })
    await store.settings.put({
      id: 'p1',
      key: 'llm.provider',
      scope: { all: true },
      value: 'main-gateway',
      secret: false,
      updatedAt: '2026-11-01T00:00:00.000Z',
    })
    await credentials.reveal(forgeToken.id)

    const response = await call('GET', '/credentials', as('admin'))
    expect(response.status).toBe(200)
    const list = (await response.json()) as CredentialList
    const byName = new Map(list.credentials.map((c) => [c.name, c]))
    expect(byName.get('widget-bot')?.usedBy).toEqual([
      { kind: 'forge', id: 'work', label: 'Forge work', href: '/settings/integrations' },
    ])
    expect(byName.get('widget-bot')?.lastUsedAt).toBe('2026-11-12T10:00:00.000Z')
    expect(byName.get('gadget-reader')?.usedBy?.map((use) => use.id)).toEqual(['libraries'])
    expect(byName.get('proxy-secret')?.usedBy?.map((use) => use.id)).toEqual(['egress'])
    expect(byName.get('main-gateway')?.usedBy?.map((use) => use.id)).toEqual(['llm.provider'])
    expect(byName.get('spare-key')?.usedBy).toEqual([])
    expect(byName.get('spare-key')?.lastUsedAt).toBeUndefined()
    expect([reader.id, proxy.id, idle.id, provider.id]).toHaveLength(4)
  })

  test('a narrow reader sees only credentials of its scope', async () => {
    await created('everything', 'gitlab')
    await created('web-only', 'gitlab', { groups: ['web'] })
    const list = (await (await call('GET', '/credentials', as('narrow'))).json()) as CredentialList
    expect(list.credentials.map((c) => c.name)).toEqual(['web-only'])
  })

  test('credential changes write audit events without secrets or lastUsedAt', async () => {
    const response = await call('POST', '/credentials', as('admin'), {
      name: 'widget-bot',
      kind: 'gitlab',
      url: 'https://forge.example.test',
      scope: { all: true },
      secret: 'very-secret',
    })
    expect(response.status).toBe(201)
    const { id } = (await response.json()) as { id: string }
    await credentials.reveal(id)
    at += 120_000
    expect(
      (await call('PATCH', `/credentials/${id}`, as('admin'), { name: 'gadget-bot' })).status,
    ).toBe(200)
    expect((await call('DELETE', `/credentials/${id}`, as('admin'))).status).toBe(204)

    const { events } = await store.audit.list({ action: 'credential' })
    const actions = events.map((event) => event.action).toSorted()
    expect(actions).toEqual(['credential.create', 'credential.delete', 'credential.update'])
    const text = JSON.stringify(events)
    expect(text).not.toContain('very-secret')
    expect(text).not.toContain('lastUsedAt')
  })
})

const putForge = async () => {
  const token = await created('widget-bot', 'gitlab')
  await store.config?.put({
    type: 'forge',
    id: 'work',
    updatedAt: '2026-11-01T00:00:00.000Z',
    data: { kind: 'gitlab', url: 'https://forge.example.test', credentialId: token.id },
  })
  return token
}

describe('GET /api/integrations/forges', () => {
  test('counts repositories and records the last webhook delivery', async () => {
    const token = await putForge()
    const before = (await (
      await call('GET', '/integrations/forges', as('admin'))
    ).json()) as IntegrationForgeList
    expect(before.forges).toEqual([
      {
        id: 'work',
        kind: 'gitlab',
        url: 'https://forge.example.test',
        credentialId: token.id,
        repos: 3,
        webhook: true,
      },
    ])

    at = Date.parse('2026-11-12T11:30:00.000Z')
    const delivery = await appOf().request('/api/webhooks/work', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gitlab-token': 'widget-hook',
        'x-gitlab-event': 'System Hook',
      },
      body: '{}',
    })
    expect(delivery.status).toBe(200)

    const after = (await (
      await call('GET', '/integrations/forges', as('admin'))
    ).json()) as IntegrationForgeList
    expect(after.forges[0]?.lastWebhookAt).toBe('2026-11-12T11:30:00.000Z')
  })

  test('a delivery with a wrong secret records nothing', async () => {
    await putForge()
    const delivery = await appOf().request('/api/webhooks/work', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gitlab-token': 'wrong' },
      body: '{}',
    })
    expect(delivery.status).toBe(401)
    const list = (await (
      await call('GET', '/integrations/forges', as('admin'))
    ).json()) as IntegrationForgeList
    expect(list.forges[0]?.lastWebhookAt).toBeUndefined()
  })

  test('needs a global settings:read, since the counts cover every repository', async () => {
    await putForge()
    expect((await call('GET', '/integrations/forges', as('narrow'))).status).toBe(403)
  })
})
