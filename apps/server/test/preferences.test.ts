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
import { defaultHomeTeams } from '../src/routes/preferences.ts'

const config = parseConfig({
  forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => ({}) as never } },
  teams: {
    games: { owns: ['work:games/*'] },
    tools: { owns: ['work:tools/*'] },
    puzzles: { owns: ['work:puzzles/*'], members: [{ id: 'widget-dev', role: 'member' }] },
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
      { scope: { teams: ['games'] }, actions: ['repos:read'] },
      { scope: { teams: ['games', 'tools', 'gone'] }, actions: ['analyses:read'] },
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
  test('home teams default to the teams of the membership, then the configured teams the grants name', () => {
    const principal = {
      id: 'widget-dev',
      grants: [
        { scope: { all: true }, actions: ['*'] },
        { scope: { teams: ['tools', 'gone'] }, actions: ['repos:read'] },
        { scope: { teams: ['puzzles', 'games'] }, actions: ['analyses:read'] },
      ],
    } satisfies Parameters<typeof defaultHomeTeams>[1]
    expect(defaultHomeTeams(config.teams, principal)).toEqual(['puzzles', 'tools', 'games'])
    expect(
      defaultHomeTeams(config.teams, {
        id: 'other',
        email: 'Widget-Dev',
        grants: [{ scope: { all: true }, actions: ['*'] }],
      }),
    ).toEqual(['puzzles'])
    expect(
      defaultHomeTeams(config.teams, {
        id: 'other',
        grants: [{ scope: { all: true }, actions: ['*'] }],
      }),
    ).toEqual([])
  })

  test('GET answers the membership and grant teams until the principal picks its own', async () => {
    const app = setup()
    expect(await read(await app.request('/api/me/preferences'))).toEqual({
      homeTeams: ['puzzles', 'games', 'tools'],
      homeTeamsFromMembership: true,
    })
  })

  test('PUT stores home teams per principal, deduplicated; null goes back to the default', async () => {
    const app = setup()
    const saved = await put(app, { homeTeams: ['tools', 'tools', 'games'] })
    expect(saved.status).toBe(200)
    expect(await read(saved)).toEqual({
      homeTeams: ['tools', 'games'],
      homeTeamsFromMembership: false,
    })
    expect(await read(await app.request('/api/me/preferences'))).toMatchObject({
      homeTeams: ['tools', 'games'],
    })
    expect(await store.kv?.get('prefs:widget-dev')).toEqual({ homeTeams: ['tools', 'games'] })
    expect((await store.audit?.list({ action: 'user.preferences' }))?.events).toHaveLength(1)

    expect(await read(await put(app, { homeTeams: [] }))).toEqual({
      homeTeams: [],
      homeTeamsFromMembership: false,
    })
    expect(await read(await put(app, { homeTeams: null }))).toEqual({
      homeTeams: ['puzzles', 'games', 'tools'],
      homeTeamsFromMembership: true,
    })
  })

  test('preferences stored before teams fall back to the default', async () => {
    await store.kv?.set('prefs:widget-dev', { homeGroups: [['games', 'tools']] })
    expect(await read(await setup().request('/api/me/preferences'))).toEqual({
      homeTeams: ['puzzles', 'games', 'tools'],
      homeTeamsFromMembership: true,
    })
  })

  test('rejects invalid input, anonymous callers and stores without kv', async () => {
    expect((await put(setup(), { homeTeams: [''] })).status).toBe(400)
    expect((await put(setup(), { homeTeams: 'games' })).status).toBe(400)
    expect((await put(setup(), { homeTeams: ['Games'] })).status).toBe(400)
    const many = Array.from({ length: 101 }, (_, n) => `team-${n}`)
    expect((await put(setup(), { homeTeams: many })).status).toBe(400)
    const anonymous: AuthProvider = {
      name: 'header',
      authenticate: async () => undefined,
      info: () => ({ provider: 'header', methods: [] }),
    }
    expect((await setup(anonymous).request('/api/me/preferences')).status).toBe(401)
    expect((await put(setup(asWidget, false), { homeTeams: ['games'] })).status).toBe(503)
    expect(await read(await setup(asWidget, false).request('/api/me/preferences'))).toMatchObject({
      homeTeamsFromMembership: true,
    })
  })
})
