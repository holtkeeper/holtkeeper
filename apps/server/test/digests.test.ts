import { beforeEach, describe, expect, test } from 'bun:test'

import type {
  ChatConversation,
  DigestList,
  DigestPreview,
  DigestRun,
  DigestView,
} from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { defineAnalysis } from '@holtkeeper/report'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { z } from 'zod'

import { createApp } from '../src/app.ts'
import type { ServerDeps } from '../src/context.ts'
import { digestServiceFor } from '../src/digests.ts'

const asAdmin = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'admin' }
const asViewer = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'viewer' }

const licenses = defineAnalysis<{
  findings: { id: string; tone: 'warning' | 'bad'; title: string }[]
}>({
  kind: 'licenses',
  label: 'Licenses',
  schema: z.object({ findings: z.array(z.any()) }),
  summarize: () => [],
  toReport: (record) => ({
    kind: 'licenses',
    title: 'Licenses',
    generatedAt: record.createdAt,
    metrics: [],
    sections: [
      { id: 'main', title: 'Findings', blocks: [{ type: 'issues', items: record.data.findings }] },
    ],
  }),
})

const auth = headerAuth({
  roles: {
    admin: [
      { scope: { all: true }, actions: ['settings:read', 'settings:write', 'analyses:read'] },
    ],
    viewer: [{ scope: { all: true }, actions: ['settings:read', 'analyses:read'] }],
  },
})

let store: Store
let deps: ServerDeps
let app: ReturnType<typeof createApp>
let now: Date

beforeEach(async () => {
  now = new Date('2026-11-02T08:00:00.000Z')
  store = memoryStore()
  const vault = aesVault('v'.repeat(32))
  deps = {
    config: parseConfig({
      forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => ({}) as never } },
      groups: { games: { forge: 'work', include: ['games/*'] } },
    }),
    auth,
    store,
    vault,
    credentials: createCredentialService({
      credentials: store.credentials,
      activity: store.activity,
      vault,
    }),
    settings: builtinSettings,
    analyses: [licenses],
    now: () => now,
  }
  app = createApp(deps)
  await store.analyses.add({
    repo: { forge: 'work', path: 'games/app-x' },
    kind: 'licenses',
    createdAt: '2026-11-01T00:00:00Z',
    data: { findings: [{ id: 'gpl', tone: 'bad', title: 'GPL-3.0 in left-pad' }] },
  })
  await store.analyses.add({
    repo: { forge: 'work', path: 'tools/cli' },
    kind: 'licenses',
    createdAt: '2026-11-01T00:00:00Z',
    data: { findings: [{ id: 'gpl', tone: 'bad', title: 'GPL-3.0 elsewhere' }] },
  })
})

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- typed bodies of test requests
const call = async <T>(method: string, path: string, body?: unknown, headers = asAdmin) => {
  const response = await app.request(`/api${path}`, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return {
    status: response.status,
    body: (response.status === 204 ? undefined : await response.json()) as T,
  }
}

const me = async () => (await call<{ principal: { id: string } }>('GET', '/me')).body.principal.id

const input = async (extra: Record<string, unknown> = {}) => ({
  name: 'Weekly compliance',
  scope: { groups: ['games'] },
  schedule: { every: 'week', days: ['mon'], time: '10:00', timezone: 'Europe/Berlin' },
  sections: [{ source: 'licenses', minTone: 'warning' }],
  targets: [{ kind: 'panel', userId: await me() }],
  ...extra,
})

const panelCards = async () =>
  (await call<ChatConversation>('GET', '/chat/messages')).body.messages.map(
    (message) => message.card,
  )

describe('digests', () => {
  test('are created with permission and only to the caller’s own chat', async () => {
    expect((await call('POST', '/digests', await input(), asViewer)).status).toBe(403)
    expect(
      (await call('POST', '/digests', await input({ targets: [{ kind: 'panel', userId: 'bob' }] })))
        .status,
    ).toBe(400)
    const created = await call<DigestView>('POST', '/digests', await input())
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({
      scheduleText: 'Every Monday at 10:00',
      nextRun: '2026-11-02T09:00:00.000Z',
    })
    const list = await call<DigestList>('GET', '/digests', undefined, asViewer)
    expect(list.body.digests.map((digest) => digest.id)).toEqual([created.body.id])
    expect(list.body.sources).toEqual([{ kind: 'licenses', label: 'Licenses' }])
    expect(list.body.presets.length).toBeGreaterThan(0)
    expect(list.body.slack).toBe(false)
  })

  test('preview what they would send, in scope only', async () => {
    const preview = await call<DigestPreview>('POST', '/digests/preview', await input())
    expect(preview.body).toMatchObject({ items: 1, empty: false, repos: 1 })
    expect(preview.body.card).toMatchObject({ title: 'Weekly compliance', tone: 'bad' })
    expect(JSON.stringify(preview.body.card)).toContain('GPL-3.0 in left-pad')
    expect(JSON.stringify(preview.body.card)).not.toContain('elsewhere')
  })

  test('go out on schedule, once, and only with new items when asked', async () => {
    const created = await call<DigestView>('POST', '/digests', await input({ onlyNew: true }))
    const service = digestServiceFor(deps)

    await service.tick()
    expect(await panelCards()).toEqual([])

    now = new Date('2026-11-02T09:01:00.000Z')
    await service.tick()
    await service.tick()
    expect((await panelCards()).map((card) => card?.title)).toEqual(['Weekly compliance'])

    now = new Date('2026-11-09T09:01:00.000Z')
    await service.tick()
    expect(await panelCards()).toHaveLength(1)
    const list = await call<DigestList>('GET', '/digests')
    expect(list.body.digests[0]?.lastRun).toMatchObject({ status: 'skipped', items: 0 })
    expect(list.body.digests[0]?.nextRun).toBe('2026-11-16T09:00:00.000Z')

    const sent = await call<DigestRun>('POST', `/digests/${created.body.id}/send`)
    expect(sent.body).toMatchObject({ status: 'sent', manual: true })
    expect(JSON.stringify((await panelCards()).at(-1))).toContain('Nothing new needs attention.')
    expect((await store.activity.list()).map((entry) => entry.action)).toContain('digest.skipped')
  })

  test('are changed and removed', async () => {
    const created = await call<DigestView>('POST', '/digests', await input())
    const updated = await call<DigestView>(
      'PUT',
      `/digests/${created.body.id}`,
      await input({ name: 'Renamed', enabled: false }),
    )
    expect(updated.body).toMatchObject({ name: 'Renamed', enabled: false })
    expect(updated.body.nextRun).toBeUndefined()
    expect((await call('DELETE', `/digests/${created.body.id}`)).status).toBe(204)
    expect((await call('DELETE', `/digests/${created.body.id}`)).status).toBe(404)
  })
})
