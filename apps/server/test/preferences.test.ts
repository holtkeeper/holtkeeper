import { beforeEach, describe, expect, test } from 'bun:test'

import type { UserPreferences } from '@holtkeeper/api'
import type { AuthProvider } from '@holtkeeper/auth'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'
import { defaultHomeGroups } from '../src/routes/preferences.ts'

const config = parseConfig({
  forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => ({}) as never } },
  groups: {
    games: { forge: 'work', include: ['games/*'] },
    tools: { forge: 'work', include: ['tools/*'] },
  },
})

let store: Store
beforeEach(() => {
  store = memoryStore()
})

const asWidget: AuthProvider = {
  name: 'header',
  authenticate: async () => ({
    id: 'widget-dev',
    name: 'Widget Dev',
    provider: 'header',
    grants: [
      { scope: { groups: ['games'] }, actions: ['repos:read'] },
      { scope: { groups: ['games', ['tools', 'shared']] }, actions: ['analyses:read'] },
    ],
  }),
  info: () => ({ provider: 'header', methods: [] }),
}

const setup = (auth: AuthProvider = asWidget, kv = true) => {
  const vault = aesVault('v'.repeat(32))
  const { kv: _, ...withoutKv } = store
  return createApp({
    config,
    auth,
    store: kv ? store : withoutKv,
    vault,
    credentials: createCredentialService({
      credentials: store.credentials,
      vault,
    }),
    settings: builtinSettings,
    analyses: [],
    now: () => new Date('2026-10-30T12:00:00.000Z'),
  })
}

const put = (app: ReturnType<typeof setup>, body: unknown) =>
  app.request('/api/me/preferences', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const read = async (response: Response) => (await response.json()) as UserPreferences

describe('preferences', () => {
  test('home groups default to the groups in the grants', () => {
    expect(
      defaultHomeGroups([
        { scope: { all: true }, actions: ['*'] },
        { scope: { groups: ['games', ['tools', 'shared']] }, actions: ['repos:read'] },
        { scope: { groups: [['tools', 'shared'], 'games'] }, actions: ['analyses:read'] },
      ]),
    ).toEqual(['games', ['tools', 'shared']])
    expect(defaultHomeGroups([{ scope: { all: true }, actions: ['*'] }])).toEqual([])
  })

  test('GET answers the grant groups until the principal picks its own', async () => {
    const app = setup()
    expect(await read(await app.request('/api/me/preferences'))).toEqual({
      homeGroups: ['games', ['tools', 'shared']],
      homeGroupsFromGrants: true,
    })
  })

  test('PUT stores home groups per principal, deduplicated; null goes back to the grants', async () => {
    const app = setup()
    const saved = await put(app, { homeGroups: ['tools', 'tools', ['games', 'tools']] })
    expect(saved.status).toBe(200)
    expect(await read(saved)).toEqual({
      homeGroups: ['tools', ['games', 'tools']],
      homeGroupsFromGrants: false,
    })
    expect(await read(await app.request('/api/me/preferences'))).toMatchObject({
      homeGroups: ['tools', ['games', 'tools']],
    })
    expect(await store.kv?.get('prefs:widget-dev')).toEqual({
      homeGroups: ['tools', ['games', 'tools']],
    })
    expect((await store.audit?.list({ action: 'user.preferences' }))?.events).toHaveLength(1)

    expect(await read(await put(app, { homeGroups: [] }))).toEqual({
      homeGroups: [],
      homeGroupsFromGrants: false,
    })
    expect(await read(await put(app, { homeGroups: null }))).toEqual({
      homeGroups: ['games', ['tools', 'shared']],
      homeGroupsFromGrants: true,
    })
  })

  test('rejects invalid input, anonymous callers and stores without kv', async () => {
    expect((await put(setup(), { homeGroups: [''] })).status).toBe(400)
    expect((await put(setup(), { homeGroups: 'games' })).status).toBe(400)
    const anonymous: AuthProvider = {
      name: 'header',
      authenticate: async () => undefined,
      info: () => ({ provider: 'header', methods: [] }),
    }
    expect((await setup(anonymous).request('/api/me/preferences')).status).toBe(401)
    expect((await put(setup(asWidget, false), { homeGroups: ['games'] })).status).toBe(503)
    expect(await read(await setup(asWidget, false).request('/api/me/preferences'))).toMatchObject({
      homeGroupsFromGrants: true,
    })
  })
})
