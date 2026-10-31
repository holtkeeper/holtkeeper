import { stat } from 'node:fs/promises'

import type { StorageProvider } from '@holtkeeper/artifacts'
import type { DatabaseInspector } from '@holtkeeper/store'

import { domainTotals } from './database.ts'

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
