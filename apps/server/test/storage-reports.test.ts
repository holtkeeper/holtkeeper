import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { StorageOverview } from '@holtkeeper/api'
import type { StorageProvider } from '@holtkeeper/artifacts'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'
import {
  reportedViews,
  requestStorageClear,
  startStorageReports,
  workerStorageReports,
} from '../src/storage-reports.ts'

const mirrors = (bytes: number, cleared: string[] = []): StorageProvider => ({
  id: 'git-mirrors',
  label: 'Git mirrors',
  usage: async () => ({ bytes, count: 2, details: [{ label: 'a.git', bytes }] }),
  clear: async (scope) => {
    cleared.push(scope ?? 'all')
    bytes = 0
    return { removed: 2, bytes }
  },
})

const tools: StorageProvider = {
  id: 'mise-cache',
  label: 'Tool cache (mise)',
  usage: async () => {
    throw new Error('du failed')
  },
}

const stops: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
})

const waitFor = async (check: () => Promise<boolean>) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error('condition never held')
}

describe('worker storage reports', () => {
  test('add up across workers, list workers as details and keep errors', async () => {
    const { kv } = memoryStore()
    if (!kv) throw new Error('memory store without kv')
    stops.push(startStorageReports({ kv, providers: [mirrors(300), tools], worker: 'worker-a' }))
    stops.push(startStorageReports({ kv, providers: [mirrors(100)], worker: 'worker-b' }))
    await waitFor(async () => (await workerStorageReports(kv)).length === 2)

    const views = reportedViews(await workerStorageReports(kv))
    expect(views.find((view) => view.id === 'git-mirrors')).toEqual({
      id: 'git-mirrors',
      label: 'Git mirrors',
      bytes: 400,
      count: 4,
      details: [
        { label: 'worker-a', bytes: 300, count: 2 },
        { label: 'worker-b', bytes: 100, count: 2 },
      ],
      available: true,
      note: 'Reported by 2 workers',
      clearable: true,
      reportedBy: 2,
    })
    expect(views.find((view) => view.id === 'mise-cache')).toMatchObject({
      bytes: 0,
      available: false,
      clearable: false,
      error: 'worker-a: du failed',
    })
  })

  test('count a volume shared by several workers once and clear it from one of them', async () => {
    const { kv } = memoryStore()
    if (!kv) throw new Error('memory store without kv')
    const shared = await mkdtemp(join(tmpdir(), 'holtkeeper-shared-'))
    try {
      const clearedBy: string[] = []
      const worker = (name: string, bytes: number) =>
        startStorageReports({
          kv,
          providers: [mirrors(bytes, clearedBy)],
          directories: { 'git-mirrors': shared },
          worker: name,
          pollMs: 10,
        })
      stops.push(worker('worker-b', 500), worker('worker-a', 500))
      await waitFor(async () => (await workerStorageReports(kv)).length === 2)
      const [view] = reportedViews(await workerStorageReports(kv))
      expect(view).toMatchObject({
        bytes: 500,
        count: 2,
        details: [{ label: 'shared: worker-a, worker-b', bytes: 500, count: 2 }],
        note: 'Reported by 2 workers, 1 volume',
        reportedBy: 2,
      })

      expect(await requestStorageClear(kv, 'git-mirrors', undefined)).toBe(2)
      await waitFor(async () => clearedBy.length === 1)
      await Bun.sleep(80)
      expect(clearedBy).toHaveLength(1)
    } finally {
      await rm(shared, { recursive: true, force: true })
    }
  })

  test('drop the report of a worker that stops', async () => {
    const { kv } = memoryStore()
    if (!kv) throw new Error('memory store without kv')
    stops.push(startStorageReports({ kv, providers: [mirrors(1)], worker: 'stays' }))
    const stop = startStorageReports({ kv, providers: [mirrors(1)], worker: 'leaves' })
    await waitFor(async () => (await workerStorageReports(kv)).length === 2)
    await stop()
    expect((await workerStorageReports(kv)).map((report) => report.worker)).toEqual(['stays'])
  })

  test('drop workers that stopped reporting', async () => {
    const { kv } = memoryStore()
    if (!kv) throw new Error('memory store without kv')
    stops.push(startStorageReports({ kv, providers: [mirrors(1)], worker: 'gone' }))
    await waitFor(async () => (await workerStorageReports(kv)).length === 1)
    const later = new Date(Date.now() + 16 * 60_000)
    expect(await workerStorageReports(kv, { now: later })).toEqual([])
  })

  test('carry out clear requests made after they started, then report again', async () => {
    const { kv } = memoryStore()
    if (!kv) throw new Error('memory store without kv')
    await requestStorageClear(kv, 'git-mirrors', undefined, { now: new Date(Date.now() - 60_000) })
    const cleared: string[] = []
    stops.push(
      startStorageReports({
        kv,
        providers: [mirrors(500, cleared)],
        worker: 'worker-a',
        pollMs: 10,
      }),
    )
    await waitFor(async () => (await workerStorageReports(kv)).length === 1)
    await Bun.sleep(50)
    expect(cleared).toEqual([])

    expect(await requestStorageClear(kv, 'git-mirrors', '30')).toBe(1)
    await waitFor(async () => cleared.length === 1)
    expect(cleared).toEqual(['30'])
    await waitFor(async () => {
      const [view] = reportedViews(await workerStorageReports(kv))
      return view?.bytes === 0
    })
  })
})

describe('storage routes with worker reports', () => {
  test('replace the local measurement and ask workers to clear', async () => {
    const store = memoryStore()
    const { kv } = store
    if (!kv) throw new Error('memory store without kv')
    const vault = aesVault('v'.repeat(32))
    const local: StorageProvider = {
      id: 'git-mirrors',
      label: 'Git mirrors',
      usage: async () => ({ bytes: 0 }),
      clear: async () => {
        throw new Error('the web process must not clear its own empty copy')
      },
    }
    const app = createApp({
      config: parseConfig({ forges: {} }),
      auth: noAuth(),
      store,
      vault,
      credentials: createCredentialService({ credentials: store.credentials, vault }),
      settings: builtinSettings,
      analyses: [],
      analyzers: [],
      storage: [local],
      now: () => new Date(),
    })
    const cleared: string[] = []
    stops.push(
      startStorageReports({
        kv,
        providers: [mirrors(700, cleared)],
        worker: 'worker-a',
        pollMs: 10,
      }),
    )
    await waitFor(async () => (await workerStorageReports(kv)).length === 1)

    const overview = (await (await app.request('/api/storage')).json()) as StorageOverview
    expect(overview.providers.map((view) => [view.id, view.bytes, view.note])).toEqual([
      ['git-mirrors', 700, 'Reported by 1 worker'],
    ])
    expect(overview.totalBytes).toBe(700)

    const response = await app.request('/api/storage/git-mirrors/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(await response.json()).toEqual({ requested: 1 })
    await waitFor(async () => cleared.length === 1)
    const [entry] = await store.activity.list({ limit: 1 })
    expect(entry).toMatchObject({ action: 'storage.cleared', details: { requested: 1 } })
  })
})
