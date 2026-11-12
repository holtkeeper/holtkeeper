import { beforeEach, describe, expect, test } from 'bun:test'

import type { IntegrationForgeList, RepoUpdatesView, WebhookReenableResult } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import type { RegisteredHook, WebhookStatus } from '@holtkeeper/forge'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'
import { repoHooks } from '../src/repo-hooks.ts'
import { markWebhookSeen } from '../src/updates.ts'
import {
  checkWebhookHealth,
  reenableTestRunning,
  webhookHealthOf,
  webhookHealthSummary,
} from '../src/webhook-health.ts'

const vault = aesVault('v'.repeat(32))
const forgeUrl = 'https://hk.test/api/webhooks/work'
const repo = { forge: 'work', path: 'shapes/widget' }

let store: Store
let at: number
let statuses: Map<string, WebhookStatus>
let enableFails: boolean | number
let enableDelay: number
let testRunning: boolean[]
let calls: string[]
let repoUrl: string

const now = () => new Date(at)

const config = parseConfig({
  forges: {
    work: {
      kind: 'gitlab',
      url: 'https://forge.test',
      create: () => ({
        webhookStatus: async (hook: RegisteredHook, url: string) => {
          calls.push(`status ${hook.scope} ${hook.target} ${hook.id}`)
          return statuses.get(`${hook.id} ${url}`) ?? { state: 'missing' }
        },
        enableWebhook: async (hook: RegisteredHook) => {
          calls.push(`enable ${hook.scope} ${hook.target} ${hook.id}`)
          if (store.kv) testRunning.push(await reenableTestRunning(store.kv, repo))
          if (enableDelay) await Bun.sleep(enableDelay)
          if (typeof enableFails === 'number')
            throw Object.assign(new Error(`GitLab answered ${enableFails}`), {
              status: enableFails,
            })
          if (enableFails) throw new Error('Hook execution failed: 502')
          for (const [key, status] of statuses)
            if (key.startsWith(`${hook.id} `))
              statuses.set(key, { state: 'enabled', id: status.id })
        },
      }),
    },
  },
  groups: { shapes: { forge: 'work', include: ['shapes/widget'] } },
})

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['*'] }],
    reader: [{ scope: { all: true }, actions: ['settings:read'] }],
    shapes: [{ scope: { groups: ['shapes'] }, actions: ['settings:read', 'settings:write'] }],
  },
})
const as = (role: string) => ({
  'x-forwarded-user': role,
  'x-forwarded-groups': role,
  'content-type': 'application/json',
})

const deps = () => ({ config, store, vault, now })

const appOf = () =>
  createApp({
    config,
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault, now }),
    settings: builtinSettings,
    analyses: [],
    now,
  })

beforeEach(async () => {
  store = memoryStore()
  at = Date.parse('2026-11-12T10:00:00.000Z')
  calls = []
  enableFails = false
  enableDelay = 0
  testRunning = []
  if (!store.kv || !store.config) throw new Error('memory store has kv and config')
  const hooks = repoHooks(store.kv, vault)
  const { token, hook } = await hooks.rotate(repo, now().toISOString())
  repoUrl = `https://hk.test/api/webhooks/r/${token}`
  await hooks.save(repo, {
    ...hook,
    registered: [{ hookId: '7', scope: 'project', target: repo.path, url: repoUrl }],
  })
  await store.config.put({
    type: 'forge',
    id: 'work',
    updatedAt: now().toISOString(),
    data: {
      kind: 'gitlab',
      url: 'https://forge.test',
      credentialId: 'c',
      webhook: {
        secret: await vault.seal('s'),
        createdAt: now().toISOString(),
        registered: [{ hookId: '1', scope: 'group', target: 'shapes', url: forgeUrl }],
      },
    },
  })
  statuses = new Map([
    [`1 ${forgeUrl}`, { state: 'disabled', id: '1' }],
    [
      `7 ${repoUrl}`,
      { state: 'temporarily_disabled', id: '7', disabledUntil: '2026-11-12T12:00:00.000Z' },
    ],
  ])
})

describe('checkWebhookHealth', () => {
  test('re-enables only the hooks Holtkeeper registered, audits and hands over to polling', async () => {
    if (!store.kv) throw new Error('kv')
    await markWebhookSeen(store.kv, repo, now())
    const lines: string[] = []
    const result = await checkWebhookHealth(deps(), {}, (line) => lines.push(line))
    expect(result).toMatchObject({ checked: 2, reenabled: 2, failed: 0 })
    expect(calls).toEqual([
      'status group shapes 1',
      'enable group shapes 1',
      'status project shapes/widget 7',
      'enable project shapes/widget 7',
    ])
    expect(testRunning).toEqual([true, true])
    expect(await reenableTestRunning(store.kv, repo)).toBe(false)
    expect(await store.kv.get('webhook-seen:work:shapes/widget')).toBeUndefined()
    expect(lines.at(-1)).toBe('webhooks: 2 re-enabled, 0 could not be re-enabled')

    const audit = await store.audit.list({ action: 'webhook.reenabled' })
    expect(audit.events.map((event) => [event.target, event.outcome, event.actor.id])).toEqual(
      expect.arrayContaining([
        [{ type: 'webhook', id: '1' }, 'ok', 'system'],
        [{ type: 'webhook', id: '7', repo: 'work:shapes/widget' }, 'ok', 'system'],
      ]),
    )
    const health = await webhookHealthOf(store.kv, repo)
    expect(health?.map((entry) => [entry.owner, entry.state, entry.reenabledAt])).toEqual([
      ['forge', 'enabled', '2026-11-12T10:00:00.000Z'],
      ['repo', 'enabled', '2026-11-12T10:00:00.000Z'],
    ])
    expect(await webhookHealthSummary(store.kv, 'work', now())).toEqual({
      checkedAt: '2026-11-12T10:00:00.000Z',
      total: 2,
      disabled: 0,
      missing: 0,
      unknown: 0,
      reenabled24h: 2,
    })
  })

  test('leaves enabled and foreign hooks alone', async () => {
    statuses = new Map([[`1 ${forgeUrl}`, { state: 'enabled', id: '1' }]])
    const result = await checkWebhookHealth(deps())
    expect(result).toMatchObject({ checked: 2, reenabled: 0, failed: 0 })
    expect(calls.filter((call) => call.startsWith('enable'))).toEqual([])
    expect(result.hooks.map((entry) => entry.state)).toEqual(['enabled', 'missing'])
  })

  test('backs off after a failed attempt unless forced', async () => {
    if (!store.kv) throw new Error('kv')
    enableFails = true
    const first = await checkWebhookHealth(deps())
    expect(first).toMatchObject({ reenabled: 0, failed: 2 })
    const stored = await webhookHealthOf(store.kv, repo)
    expect(stored?.[0]).toMatchObject({
      state: 'disabled',
      failures: 1,
      retryAt: '2026-11-12T10:15:00.000Z',
      lastError: 'Hook execution failed: 502',
    })
    expect((await store.audit.list({ action: 'webhook.reenabled' })).events[0]?.outcome).toBe(
      'error',
    )

    calls = []
    at += 5 * 60_000
    await checkWebhookHealth(deps())
    expect(calls.filter((call) => call.startsWith('enable'))).toEqual([])

    at += 11 * 60_000
    const third = await checkWebhookHealth(deps())
    expect(third.hooks[0]).toMatchObject({ failures: 2, retryAt: '2026-11-12T10:46:00.000Z' })

    calls = []
    enableFails = false
    await checkWebhookHealth(deps(), { forge: 'work', force: true })
    expect(calls.filter((call) => call.startsWith('enable'))).toEqual([])

    at += 60_000
    const forced = await checkWebhookHealth(deps(), { forge: 'work', force: true })
    expect(forced).toMatchObject({ reenabled: 2, failed: 0 })
    expect(forced.hooks[0]).not.toHaveProperty('failures')
  })

  test('a rate-limited attempt retries in a minute without counting as failed', async () => {
    if (!store.kv) throw new Error('kv')
    enableFails = 429
    const result = await checkWebhookHealth(deps())
    expect(result).toMatchObject({ reenabled: 0, failed: 0 })
    expect(result.hooks[0]).toMatchObject({
      state: 'disabled',
      retryAt: '2026-11-12T10:01:00.000Z',
    })
    expect(result.hooks[0]).not.toHaveProperty('failures')
    expect((await store.audit.list({ action: 'webhook.reenabled' })).events).toEqual([])
  })

  test('overlapping runs of a forge send one test delivery per hook', async () => {
    enableDelay = 20
    const [first, second] = await Promise.all([
      checkWebhookHealth(deps()),
      checkWebhookHealth(deps(), { forge: 'work', force: true }),
    ])
    expect(calls.filter((call) => call.startsWith('enable'))).toHaveLength(2)
    expect(first.reenabled + second.reenabled).toBe(2)
    expect(second.hooks.map((entry) => entry.state)).toEqual(['enabled', 'enabled'])
  })

  test('a hook found under a new id updates the stored registration', async () => {
    if (!store.kv || !store.config) throw new Error('kv')
    statuses = new Map([
      [`1 ${forgeUrl}`, { state: 'enabled', id: '1' }],
      [`7 ${repoUrl}`, { state: 'disabled', id: '8' }],
    ])
    const result = await checkWebhookHealth(deps())
    expect(calls).toContain('enable project shapes/widget 8')
    expect(result.hooks.map((entry) => entry.hookId)).toEqual(['1', '8'])
    const saved = await repoHooks(store.kv, vault).get(repo)
    expect(saved?.registered?.map((hook) => hook.hookId)).toEqual(['8'])
    expect((await webhookHealthOf(store.kv, repo))?.map((entry) => entry.hookId)).toEqual([
      '1',
      '8',
    ])
    const audit = await store.audit.list({ action: 'webhook.reenabled' })
    expect(audit.events[0]?.target.id).toBe('8')
  })

  test('a repository check touches only hooks that reach it and keeps the others', async () => {
    if (!store.kv) throw new Error('kv')
    await checkWebhookHealth(deps())
    calls = []
    const other = { forge: 'work', path: 'gears/bolt' }
    const result = await checkWebhookHealth(deps(), { repo: other, force: true })
    expect(result.checked).toBe(0)
    expect(calls).toEqual([])
    expect(await webhookHealthOf(store.kv, repo)).toHaveLength(2)
  })
})

describe('re-enable routes', () => {
  test('Settings › Integrations re-enables a forge now and shows the counts', async () => {
    expect(
      (
        await appOf().request('/api/integrations/forges/work/webhooks/reenable', {
          method: 'POST',
          headers: as('reader'),
        })
      ).status,
    ).toBe(403)
    const response = await appOf().request('/api/integrations/forges/work/webhooks/reenable', {
      method: 'POST',
      headers: as('admin'),
    })
    expect(response.status).toBe(200)
    expect((await response.json()) as WebhookReenableResult).toMatchObject({
      checked: 2,
      reenabled: 2,
    })
    const audit = await store.audit.list({ action: 'forge.webhooks_reenable' })
    expect(audit.events[0]?.details).toEqual({ checked: 2, reenabled: 2, failed: 0 })
    expect(
      (await store.audit.list({ action: 'webhook.reenabled' })).events.map((e) => e.actor.id),
    ).toEqual(['header:admin', 'header:admin'])

    const list = (await (
      await appOf().request('/api/integrations/forges', { headers: as('reader') })
    ).json()) as IntegrationForgeList
    expect(list.forges[0]?.webhookHealth).toMatchObject({ total: 2, disabled: 0, reenabled24h: 2 })
  })

  test('a repository-scoped grant re-enables only the repository hook', async () => {
    const response = await appOf().request('/api/repos/updates/webhook/reenable', {
      method: 'POST',
      headers: as('shapes'),
      body: JSON.stringify({ repo: `work:${repo.path}` }),
    })
    expect(response.status).toBe(200)
    expect(calls.filter((call) => call.startsWith('enable'))).toEqual([
      'enable project shapes/widget 7',
    ])
  })

  test('the receiver ignores pushes while a re-enable test delivery runs', async () => {
    if (!store.kv) throw new Error('kv')
    const token = repoUrl.split('/').at(-1) ?? ''
    const push = () =>
      appOf().request(`/api/webhooks/r/${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-gitlab-event': 'Push Hook' },
        body: JSON.stringify({
          object_kind: 'push',
          ref: 'refs/heads/main',
          after: 'a'.repeat(40),
          project: { path_with_namespace: repo.path, web_url: 'https://forge.test/shapes/widget' },
        }),
      })
    await store.kv.set('webhook-test:work:shapes/widget', true, 60)
    const response = await push()
    expect(response.status).toBe(200)
    expect(((await response.json()) as { ignored?: string }).ignored).toBe(
      'test push sent to re-enable the hook',
    )
  })

  test('the repository Updates panel re-enables the hooks that reach it', async () => {
    const before = (await (
      await appOf().request(`/api/repos/updates?repo=work:${repo.path}`, { headers: as('admin') })
    ).json()) as RepoUpdatesView
    expect(before.webhookHealth).toBeUndefined()

    const response = await appOf().request('/api/repos/updates/webhook/reenable', {
      method: 'POST',
      headers: as('admin'),
      body: JSON.stringify({ repo: `work:${repo.path}` }),
    })
    expect(response.status).toBe(200)
    const view = (await response.json()) as RepoUpdatesView
    expect(view.webhookHealth?.map((entry) => entry.state)).toEqual(['enabled', 'enabled'])
    expect(
      (await store.audit.list({ action: 'repo.webhook_reenable' })).events[0]?.target.repo,
    ).toBe('work:shapes/widget')
  })
})
