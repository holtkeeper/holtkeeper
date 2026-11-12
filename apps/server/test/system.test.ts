import { describe, expect, test } from 'bun:test'

import type { StorageOverview, SystemHealth } from '@holtkeeper/api'
import type { StorageProvider } from '@holtkeeper/artifacts'
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
import { periodicDuty } from '../src/leader.ts'
import {
  recordStorageSnapshot,
  storageHistory,
  storageOverview,
  weekAgoSnapshot,
} from '../src/storage.ts'

const config = parseConfig({
  forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => ({}) as never } },
  groups: { widgets: { forge: 'work', include: ['widgets/*'] } },
})

const now = new Date('2026-11-12T12:00:00.000Z')

const area = (id: string, bytes: number): StorageProvider => ({
  id,
  label: id,
  usage: async () => ({ bytes }),
})

const kvOf = (store: Store) => {
  if (!store.kv) throw new Error('memory store without kv')
  return store.kv
}

const setup = (
  store: Store,
  options: { auth?: AuthProvider; storage?: StorageProvider[]; version?: string } = {},
) => {
  const vault = aesVault('v'.repeat(32))
  return createApp({
    config,
    auth: options.auth ?? noAuth(),
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [],
    storage: options.storage ?? [],
    ...(options.version && { version: options.version }),
    now: () => now,
  })
}

const overview = (areas: Record<string, number>): StorageOverview => {
  const providers = Object.entries(areas).map(([id, bytes]) => ({
    id,
    label: id,
    bytes,
    details: [],
    available: true,
    clearable: false,
  }))
  return { providers, totalBytes: providers.reduce((sum, view) => sum + view.bytes, 0) }
}

describe('storage snapshots', () => {
  test('keep one point per day for 90 days and find the one a week back', async () => {
    const kv = kvOf(memoryStore())
    await recordStorageSnapshot(kv, overview({ artifacts: 10 }), new Date('2026-08-01T10:00:00Z'))
    await recordStorageSnapshot(kv, overview({ artifacts: 40 }), new Date('2026-11-04T10:00:00Z'))
    await recordStorageSnapshot(kv, overview({ artifacts: 50 }), new Date('2026-11-05T09:00:00Z'))
    await recordStorageSnapshot(
      kv,
      overview({ artifacts: 60, database: 5 }),
      new Date('2026-11-05T21:00:00Z'),
    )
    const history = await storageHistory(kv)
    expect(history.map((point) => point.day)).toEqual(['2026-11-04', '2026-11-05'])
    expect(history[1]).toEqual({
      day: '2026-11-05',
      bytes: 65,
      areas: { artifacts: 60, database: 5 },
    })
    expect(weekAgoSnapshot(history, now)?.day).toBe('2026-11-05')
    expect(weekAgoSnapshot(history, new Date('2026-11-11T12:00:00Z'))?.day).toBe('2026-11-04')
    expect(weekAgoSnapshot(history, new Date('2026-11-10T12:00:00Z'))).toBeUndefined()
  })

  test('leave unavailable areas out of the snapshot', async () => {
    const kv = kvOf(memoryStore())
    const measured = await storageOverview({
      providers: [
        area('artifacts', 30),
        {
          id: 'mise-cache',
          label: 'Tools',
          usage: async () => {
            throw new Error('du failed')
          },
        },
      ],
      kv,
      now,
    })
    expect(measured.providers.find((view) => view.id === 'mise-cache')).toMatchObject({
      available: false,
      error: 'du failed',
    })
    expect((await recordStorageSnapshot(kv, measured, now)).areas).toEqual({ artifacts: 30 })
  })
})

describe('periodicDuty', () => {
  test('runs at once, logs failures and stops', async () => {
    const lines: string[] = []
    let runs = 0
    const duty = periodicDuty(
      'widget sweep',
      async () => {
        runs += 1
        throw new Error('boom')
      },
      { intervalMs: 5, log: (line) => lines.push(line) },
    )
    const stop = await duty()
    await Bun.sleep(30)
    await stop()
    const after = runs
    await Bun.sleep(20)
    expect(after).toBeGreaterThan(1)
    expect(runs).toBe(after)
    expect(lines[0]).toBe('widget sweep: run failed: boom')
  })
})

describe('GET /api/system/health', () => {
  test('reports checks, storage against the week-old snapshot and the version', async () => {
    const store = memoryStore()
    await recordStorageSnapshot(
      kvOf(store),
      overview({ artifacts: 100, database: 40 }),
      new Date('2026-11-04T08:00:00Z'),
    )
    const app = setup(store, {
      storage: [area('artifacts', 160), area('database', 30)],
      version: '1.2.3',
    })
    const response = await app.request('/api/system/health')
    expect(response.status).toBe(200)
    const health = (await response.json()) as SystemHealth
    expect(health.storage).toEqual({
      totalBytes: 190,
      since: '2026-11-04',
      weekAgoBytes: 140,
      weekAgo: { artifacts: 100, database: 40 },
    })
    expect(health.checks.map((check) => [check.id, check.status, check.detail])).toEqual([
      ['store', 'ok', 'answering'],
      ['workers', 'warn', 'no worker reported in 15 minutes'],
      ['library-index', 'ok', 'not run yet'],
    ])
    expect(health).toMatchObject({
      status: 'warn',
      workers: 0,
      version: '1.2.3',
      checkedAt: now.toISOString(),
      startedAt: now.toISOString(),
    })
  })

  test('has no week-old figures without a snapshot', async () => {
    const health = (await (
      await setup(memoryStore(), { storage: [area('artifacts', 5)] }).request('/api/system/health')
    ).json()) as SystemHealth
    expect(health.storage).toEqual({ totalBytes: 5 })
  })

  test('warns about retired repo.readOnly entries and leaves out a blank version', async () => {
    const store = memoryStore()
    for (const [id, value] of [
      ['frozen', true],
      ['open', false],
    ] as const)
      await store.settings.put({
        id,
        key: 'repo.readOnly',
        scope: { repos: ['work:widgets/board'] },
        value,
        secret: false,
        updatedAt: now.toISOString(),
      })
    const health = (await (
      await setup(store, { version: '  ' }).request('/api/system/health')
    ).json()) as SystemHealth
    expect(health.checks.find((check) => check.id === 'retired-read-only')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('1 retired repo.readOnly entry'),
    })
    expect(health.version).toBeUndefined()
  })

  test('needs a global settings:read', async () => {
    const app = setup(memoryStore(), {
      auth: headerAuth({
        roles: { widgets: [{ scope: { groups: ['widgets'] }, actions: ['settings:read'] }] },
      }),
    })
    const response = await app.request('/api/system/health', {
      headers: { 'x-forwarded-user': 'ann', 'x-forwarded-groups': 'widgets' },
    })
    expect(response.status).toBe(403)
  })
})
