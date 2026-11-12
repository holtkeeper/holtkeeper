import { stat } from 'node:fs/promises'

import type { StorageOverview, StorageProviderView } from '@holtkeeper/api'
import type { StorageProvider } from '@holtkeeper/artifacts'
import type { DatabaseInspector, KvStore } from '@holtkeeper/store'
import { z } from 'zod'

import { domainTotals } from './database.ts'
import { reportedViews, workerStorageReports } from './storage-reports.ts'

const HISTORY_KEY = 'storage:history'
const KEEP_DAYS = 90
const DAY_MS = 86_400_000

const historySchema = z.object({
  days: z.array(
    z.object({ day: z.string(), bytes: z.number(), areas: z.record(z.string(), z.number()) }),
  ),
})

/** One recorded day of `storage:history`: the total and the bytes per storage area id. */
type StorageSnapshot = z.infer<typeof historySchema>['days'][number]

const size = (path: string) =>
  stat(path).then(
    (info) => info.size,
    () => undefined,
  )

/**
 * The database as a storage provider. A Postgres store reports the database size, split by
 * domain; SQLite the file plus its `-wal` and `-shm` companions. Without either (memory store,
 * or `server.databasePath` unset) it reports itself unavailable.
 */
export function databaseStorage(
  path: string | undefined,
  inspector?: DatabaseInspector,
): StorageProvider {
  return {
    id: 'database',
    label: 'Database',
    async usage() {
      if (inspector?.engine === 'postgres') {
        const [overview, tables] = await Promise.all([inspector.overview(), inspector.tables()])
        return {
          bytes: overview.bytes,
          details: domainTotals(tables).map((domain) => ({
            label: domain.domain,
            bytes: domain.bytes,
            count: domain.rows,
          })),
          note: overview.version,
        }
      }
      if (!path || path === ':memory:')
        return {
          bytes: 0,
          available: false,
          note: 'in-memory store or server.databasePath not set',
        }
      const details = []
      for (const [label, file] of [
        ['database', path],
        ['write-ahead log', `${path}-wal`],
        ['shared memory', `${path}-shm`],
      ] as const) {
        const bytes = await size(file)
        if (bytes !== undefined) details.push({ label, bytes })
      }
      if (!details.length) return { bytes: 0, available: false, note: `${path} does not exist` }
      return { bytes: details.reduce((sum, detail) => sum + detail.bytes, 0), details, note: path }
    },
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function localView(provider: StorageProvider): Promise<StorageProviderView> {
  const base = { id: provider.id, label: provider.label, clearable: provider.clear !== undefined }
  try {
    const usage = await provider.usage()
    return {
      ...base,
      bytes: usage.bytes,
      ...(usage.count !== undefined ? { count: usage.count } : {}),
      details: usage.details ?? [],
      available: usage.available ?? true,
      ...(usage.note ? { note: usage.note } : {}),
    }
  } catch (error) {
    return { ...base, bytes: 0, details: [], available: false, error: messageOf(error) }
  }
}

/**
 * Every storage area now: what workers reported to `kv` in the last 15 minutes, and this
 * process's own `providers` for the ids no worker reports. A provider that fails to measure is
 * listed unavailable with its error.
 */
export async function storageOverview(options: {
  providers: readonly StorageProvider[]
  kv: Pick<KvStore, 'get'> | undefined
  now: Date
}): Promise<StorageOverview> {
  const remote = options.kv
    ? reportedViews(await workerStorageReports(options.kv, { now: options.now }))
    : []
  const remoteIds = new Set(remote.map((view) => view.id))
  const local = await Promise.all(
    options.providers.filter((provider) => !remoteIds.has(provider.id)).map(localView),
  )
  const providers = [...local, ...remote]
  return { providers, totalBytes: providers.reduce((sum, view) => sum + view.bytes, 0) }
}

/** Recorded daily storage snapshots, oldest first; empty without any. */
export async function storageHistory(
  kv: Pick<KvStore, 'get'> | undefined,
): Promise<StorageSnapshot[]> {
  if (!kv) return []
  return historySchema.safeParse(await kv.get(HISTORY_KEY)).data?.days ?? []
}

/** The newest snapshot at least seven days before `now`, if any. */
export function weekAgoSnapshot(
  history: readonly StorageSnapshot[],
  now: Date,
): StorageSnapshot | undefined {
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS).toISOString().slice(0, 10)
  return history.findLast((point) => point.day <= weekAgo)
}

/**
 * Records `overview` as today's storage snapshot (replacing an earlier one of the same UTC day),
 * keeping the last 90 days. Unavailable areas are left out of `areas`.
 */
export async function recordStorageSnapshot(
  kv: Pick<KvStore, 'get' | 'set'>,
  overview: StorageOverview,
  now: Date,
): Promise<StorageSnapshot> {
  const point: StorageSnapshot = {
    day: now.toISOString().slice(0, 10),
    bytes: overview.totalBytes,
    areas: Object.fromEntries(
      overview.providers.filter((view) => view.available).map((view) => [view.id, view.bytes]),
    ),
  }
  const oldest = new Date(now.getTime() - KEEP_DAYS * DAY_MS).toISOString().slice(0, 10)
  const days = (await storageHistory(kv)).filter(
    (entry) => entry.day !== point.day && entry.day > oldest,
  )
  await kv.set(HISTORY_KEY, {
    days: [...days, point].toSorted((a, b) => a.day.localeCompare(b.day)),
  })
  return point
}
