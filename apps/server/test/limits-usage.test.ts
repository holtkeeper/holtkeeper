import { beforeEach, describe, expect, test } from 'bun:test'

import type { Scope } from '@holtkeeper/access'
import type { LimitUsageList } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { type CredentialService, createCredentialService } from '@holtkeeper/credentials'
import type { GitForge } from '@holtkeeper/forge'
import {
  type Limiter,
  type ManualClock,
  createLimiter,
  createManualClock,
} from '@holtkeeper/limits'
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
})

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['*'] }],
    narrow: [{ scope: { groups: ['web'] }, actions: ['settings:read'] }],
    settings: [{ scope: { all: true }, actions: ['settings:read'] }],
    web: [
      { scope: { all: true }, actions: ['settings:read'] },
      { scope: { groups: ['web'] }, actions: ['credentials:read'] },
    ],
  },
})
const as = (role: string) => ({ 'x-forwarded-user': role, 'x-forwarded-groups': role })

const vault = aesVault('v'.repeat(32))
let store: Store
let credentials: CredentialService
let clock: ManualClock
let limiter: Limiter
let app: ReturnType<typeof createApp>

const created = (
  name: string,
  kind: string,
  options?: Record<string, unknown>,
  scope: Scope = { all: true },
) =>
  credentials.create({
    name,
    kind,
    url: 'https://forge.example.test',
    scope,
    secret: `${name}-secret`,
    ...(options && { options }),
  })

const usage = async (role = 'admin') => {
  const response = await app.request('/api/limits/usage', { headers: as(role) })
  return { status: response.status, body: (await response.json()) as LimitUsageList }
}

beforeEach(() => {
  store = memoryStore()
  clock = createManualClock(Date.parse('2026-11-12T10:00:00.000Z'))
  credentials = createCredentialService({
    credentials: store.credentials,
    vault,
    now: () => new Date(clock.now()),
  })
  limiter = createLimiter({ clock })
  app = createApp({
    config,
    auth,
    store,
    vault,
    credentials,
    limiter,
    settings: builtinSettings,
    analyses: [],
    now: () => new Date(clock.now()),
  })
})

const names = async (role: string) => {
  const { status, body } = await usage(role)
  expect(status).toBe(200)
  return body.rows.map((row) => row.name)
}

describe('GET /api/limits/usage', () => {
  test('lists limited credentials with resolved policies and live counters', async () => {
    const bot = await created('widget-bot', 'gitlab')
    const key = await created('main-gateway', 'anthropic', { tokensPerMinute: 40_000 })
    await created('proxy-secret', 'egress-secret')
    await store.settings.put({
      id: 'l1',
      key: 'limits.credentials',
      scope: { all: true },
      value: {
        'main-gateway': { tokensPerDay: 1_000_000 },
        'forge:work': { maxConcurrent: 2 },
        'gone-key': { requestsPerMinute: 10 },
      },
      secret: false,
      updatedAt: '2026-11-01T00:00:00.000Z',
    })

    await (await limiter.acquire(bot.id, { requests: 4 })).release()
    const held = await limiter.acquire(bot.id)
    await limiter.throttle(bot.id, { delayMs: 30_000 })
    await (await limiter.acquire(key.id, { tokens: 100 })).release({ tokens: 900, costUsd: 0.5 })
    await (await limiter.acquire('forge:work')).release()

    const { status, body } = await usage()
    expect(status).toBe(200)
    expect(body.shared).toBe(false)
    expect(body.rows.map((row) => row.name)).toEqual([
      'Forge work',
      'main-gateway',
      'widget-bot',
      'gone-key',
    ])
    const byName = new Map(body.rows.map((row) => [row.name, row]))
    expect(byName.get('widget-bot')).toEqual({
      key: bot.id,
      credentialId: bot.id,
      name: 'widget-bot',
      kind: 'gitlab',
      policy: { maxConcurrent: 8, requestsPerMinute: 300 },
      source: 'default',
      requestsLastHour: 5,
      tokensLastHour: 0,
      inFlight: 1,
      coolDownUntil: '2026-11-12T10:00:30.000Z',
      last429At: '2026-11-12T10:00:00.000Z',
      dayTokens: 0,
      dayCostUsd: 0,
    })
    expect(byName.get('main-gateway')).toMatchObject({
      policy: { maxConcurrent: 3, tokensPerMinute: 40_000, tokensPerDay: 1_000_000 },
      source: 'configured',
      tokensLastHour: 900,
      dayTokens: 900,
      dayCostUsd: 0.5,
    })
    expect(byName.get('Forge work')).toMatchObject({
      key: 'forge:work',
      kind: 'gitlab',
      policy: { maxConcurrent: 2 },
      source: 'configured',
      requestsLastHour: 1,
    })
    expect(byName.get('gone-key')).toMatchObject({ missing: true, source: 'configured' })
    expect(limiter.policy(key.id)).toMatchObject({ tokensPerDay: 1_000_000 })
    await held.release()
  })

  test('answers from a 5 second cache', async () => {
    const bot = await created('widget-bot', 'gitlab')
    expect((await usage()).body.rows[0]?.requestsLastHour).toBe(0)
    await (await limiter.acquire(bot.id)).release()
    await clock.advance(4_000)
    expect((await usage()).body.rows[0]?.requestsLastHour).toBe(0)
    await clock.advance(1_000)
    expect((await usage()).body.rows[0]?.requestsLastHour).toBe(1)
  })

  test('needs a global settings:read', async () => {
    expect((await usage('narrow')).status).toBe(403)
  })

  test('shows credential rows only to callers that may read the credential', async () => {
    await created('widget-bot', 'gitlab')
    await created('web-bot', 'gitlab', undefined, { groups: ['web'] })
    await store.settings.put({
      id: 'l1',
      key: 'limits.credentials',
      scope: { all: true },
      value: { 'forge:work': { maxConcurrent: 2 }, 'gone-key': { requestsPerMinute: 10 } },
      secret: false,
      updatedAt: '2026-11-01T00:00:00.000Z',
    })
    expect(await names('admin')).toEqual(['Forge work', 'web-bot', 'widget-bot', 'gone-key'])
    expect(await names('settings')).toEqual(['Forge work', 'gone-key'])
    expect(await names('web')).toEqual(['Forge work', 'web-bot', 'gone-key'])
  })
})
