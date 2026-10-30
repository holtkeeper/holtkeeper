import { stat } from 'node:fs/promises'

import type { StorageProvider } from '@holtkeeper/artifacts'

const size = (path: string) =>
  stat(path).then(
    (info) => info.size,
    () => undefined,
  )

/**
 * The SQLite database as a storage provider: the file plus its `-wal` and `-shm` companions.
 * Without a path (memory store, or `server.databasePath` unset) it reports itself unavailable.
 */
export function databaseStorage(path: string | undefined): StorageProvider {
  return {
    id: 'database',
    label: 'Database',
    async usage() {
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
