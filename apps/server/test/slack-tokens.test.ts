import { beforeEach, describe, expect, test } from 'bun:test'

import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'

const NOW = new Date('2026-11-03T09:00:00.000Z')
const asAdmin = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'admin' }
const asViewer = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'viewer' }

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['settings:read', 'settings:write'] }],
    viewer: [{ scope: { all: true }, actions: ['settings:read'] }],
  },
})

let store: Store
let app: ReturnType<typeof createApp>

beforeEach(() => {
  store = memoryStore()
  const vault = aesVault('v'.repeat(32))
  app = createApp({
    config: parseConfig({ forges: {}, server: { auth, store, vaultKey: 'v'.repeat(32) } }),
    auth,
    store,
    vault,
    credentials: createCredentialService({
      credentials: store.credentials,
      vault,
    }),
    settings: builtinSettings,
    analyses: [],
    now: () => NOW,
  })
})

const common = {
  emoji: {},
  defaultEmoji: {
    reviewing: 'hk-reviewing',
    clean: 'hk-clean',
    minor: 'hk-minor',
    changes: 'hk-changes',
    skipped: 'hk-skipped',
  },
  fallbackEmoji: {
    reviewing: 'eyes',
    clean: 'large_green_circle',
    minor: 'large_orange_circle',
    changes: 'red_circle',
    skipped: 'white_circle',
  },
  eventsPath: '/api/slack/events',
}
const unset = { configured: false, ...common }

const call = async (method: string, path: string, body?: unknown, headers = asAdmin) => {
  const response = await app.request(`/api${path}`, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json: unknown = await response.json().catch(() => undefined)
  return { status: response.status, body: json }
}

describe('slack tokens', () => {
  test('stores the tokens sealed, reports them and forgets them', async () => {
    expect((await call('GET', '/slack')).body).toEqual(unset)

    const saved = await call('PUT', '/slack/connection', {
      botToken: 'xoxb-widget-1',
      signingSecret: 'shape-secret',
    })
    expect(saved).toEqual({
      status: 200,
      body: {
        configured: true,
        connectedAt: NOW.toISOString(),
        connectedBy: 'header:jane',
        ...common,
      },
    })
    const stored = JSON.stringify(await store.kv?.get('chat:slack:connection'))
    expect(stored).not.toContain('xoxb-widget-1')
    expect(stored).not.toContain('shape-secret')

    expect((await call('DELETE', '/slack/connection')).body).toEqual(unset)
    expect(await store.kv?.get('chat:slack:connection')).toBeUndefined()
  })

  test('rejects a token that is not a bot token', async () => {
    const response = await call('PUT', '/slack/connection', {
      botToken: 'xoxp-widget',
      signingSecret: 'shape-secret',
    })
    expect(response.status).toBe(400)
    expect((await call('GET', '/slack')).body).toEqual(unset)
  })

  test('only settings writers change the tokens', async () => {
    const body = { botToken: 'xoxb-widget-1', signingSecret: 'shape-secret' }
    expect((await call('PUT', '/slack/connection', body, asViewer)).status).toBe(403)
    expect((await call('GET', '/slack', undefined, asViewer)).status).toBe(200)
  })

  test('keeps emoji overrides on the credential, also when the tokens are replaced', async () => {
    const tokens = { botToken: 'xoxb-widget-1', signingSecret: 'shape-secret' }
    expect((await call('PUT', '/slack/emoji', { emoji: { clean: 'ok' } })).status).toBe(409)
    await call('PUT', '/slack/connection', tokens)

    const set = await call('PUT', '/slack/emoji', {
      emoji: { clean: ':white_check_mark:', reviewing: 'hourglass' },
    })
    expect(set.status).toBe(200)
    expect(set.body).toMatchObject({ emoji: { clean: 'white_check_mark', reviewing: 'hourglass' } })
    await call('PUT', '/slack/connection', { ...tokens, botToken: 'xoxb-widget-2' })
    expect((await call('GET', '/slack')).body).toMatchObject({
      emoji: { clean: 'white_check_mark', reviewing: 'hourglass' },
    })

    expect((await call('PUT', '/slack/emoji', { emoji: { clean: 'not an emoji' } })).status).toBe(
      400,
    )
    expect((await call('PUT', '/slack/emoji', { emoji: { clean: 'ok' } }, asViewer)).status).toBe(
      403,
    )
    expect((await call('PUT', '/slack/emoji', { emoji: {} })).body).toMatchObject({ emoji: {} })
  })

  test('refuses unknown statuses and drops the emoji with the credential', async () => {
    const tokens = { botToken: 'xoxb-widget-1', signingSecret: 'shape-secret' }
    await call('PUT', '/slack/connection', tokens)
    expect((await call('PUT', '/slack/emoji', { emoji: { wow: 'eyes' } })).status).toBe(400)
    const set = await call('PUT', '/slack/emoji', { emoji: { clean: 'thumbsup::skin-tone-2' } })
    expect(set.body).toMatchObject({ emoji: { clean: 'thumbsup::skin-tone-2' } })

    await call('DELETE', '/slack/connection')
    await call('PUT', '/slack/connection', tokens)
    expect((await call('GET', '/slack')).body).toMatchObject({ emoji: {} })
  })
})
