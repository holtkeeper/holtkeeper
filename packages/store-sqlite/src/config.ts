import type { Database } from 'bun:sqlite'

import type {
  AnyConfigDocument,
  ConfigDocument,
  ConfigDocumentType,
  ConfigRevision,
  ConfigStore,
  KvLease,
  KvStore,
} from '@holtkeeper/store'
import { canonicalJson, isKvLease } from '@holtkeeper/store'

interface DocumentRow {
  type: ConfigDocumentType
  id: string
  data: string
  version: number
  updated_at: string
  updated_by: string | null
}

type RevisionRow = Omit<DocumentRow, 'type' | 'id'>

const toDocument = (row: DocumentRow): AnyConfigDocument => ({
  type: row.type,
  id: row.id,
  data: JSON.parse(row.data),
  version: row.version,
  updatedAt: row.updated_at,
  ...(row.updated_by !== null && { updatedBy: row.updated_by }),
})

const toRevision = (row: RevisionRow): ConfigRevision => ({
  version: row.version,
  data: JSON.parse(row.data),
  updatedAt: row.updated_at,
  ...(row.updated_by !== null && { updatedBy: row.updated_by }),
})

/** The SQLite `ConfigStore`: current versions in `config_documents`, older ones in `config_history`. */
export function sqliteConfig(db: Database): ConfigStore {
  const sql = {
    get: db.query<DocumentRow, [string, string]>(
      'SELECT * FROM config_documents WHERE type = ? AND id = ?',
    ),
    list: db.query<DocumentRow, [string | null]>(
      'SELECT * FROM config_documents WHERE ?1 IS NULL OR type = ?1 ORDER BY type, id',
    ),
    upsert: db.query<
      DocumentRow,
      [string, string, string, number, string, string | null]
    >(`INSERT INTO config_documents (type, id, data, version, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (type, id) DO UPDATE SET data = excluded.data, version = excluded.version,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by
       RETURNING *`),
    archive: db.query<null, [string, string]>(
      `INSERT INTO config_history (type, id, version, data, updated_at, updated_by)
       SELECT type, id, version, data, updated_at, updated_by FROM config_documents
       WHERE type = ? AND id = ?`,
    ),
    history: db.query<RevisionRow, [string, string]>(
      'SELECT version, data, updated_at, updated_by FROM config_history WHERE type = ? AND id = ? ORDER BY version DESC',
    ),
    remove: db.query<null, [string, string]>(
      'DELETE FROM config_documents WHERE type = ? AND id = ?',
    ),
    removeHistory: db.query<null, [string, string]>(
      'DELETE FROM config_history WHERE type = ? AND id = ?',
    ),
  }

  const put = db.transaction((input: Omit<AnyConfigDocument, 'version'>) => {
    const previous = sql.get.get(input.type, input.id)
    if (previous) sql.archive.run(input.type, input.id)
    const row = sql.upsert.get(
      input.type,
      input.id,
      JSON.stringify(input.data),
      (previous?.version ?? 0) + 1,
      input.updatedAt,
      input.updatedBy ?? null,
    )
    if (!row) throw new Error('config document was not stored')
    return toDocument(row)
  })

  function list<T extends ConfigDocumentType>(type: T): Promise<ConfigDocument<T>[]>
  function list(): Promise<AnyConfigDocument[]>
  async function list(type?: ConfigDocumentType) {
    return sql.list.all(type ?? null).map(toDocument)
  }

  return {
    put: async <T extends ConfigDocumentType>(input: Omit<ConfigDocument<T>, 'version'>) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the stored row has input's type
      put.immediate(input) as ConfigDocument<T>,
    async get<T extends ConfigDocumentType>(type: T, id: string) {
      const row = sql.get.get(type, id)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the row was selected by type
      return row ? (toDocument(row) as ConfigDocument<T>) : undefined
    },
    list,
    history: async <T extends ConfigDocumentType>(type: T, id: string) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- rows were selected by type
      sql.history.all(type, id).map(toRevision) as ConfigRevision<T>[],
    async remove(type, id) {
      db.transaction(() => {
        sql.remove.run(type, id)
        sql.removeHistory.run(type, id)
      }).immediate()
    },
  }
}

/** Expiry in epoch ms for a TTL; `null` without one. Rejects non-positive TTLs. */
const ttl = (seconds: number | undefined, from = Date.now()) => {
  if (seconds !== undefined && !(seconds > 0)) throw new Error('ttlSeconds must be > 0')
  return seconds === undefined ? null : from + seconds * 1000
}

/** The SQLite `KvStore` in table `kv`; `expires_at` is epoch milliseconds. */
export function sqliteKv(db: Database): KvStore {
  const sql = {
    get: db.query<{ value: string }, [string, number]>(
      'SELECT value FROM kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)',
    ),
    set: db.query<null, [string, string, number | null]>(
      `INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
    ),
    delete: db.query<null, [string]>('DELETE FROM kv WHERE key = ?'),
    sweep: db.query<null, [number]>(
      'DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?',
    ),
  }
  const acquire = db.transaction((key: string, holder: string, seconds: number, at: number) => {
    const row = sql.get.get(key, at)
    const current: unknown = row ? JSON.parse(row.value) : undefined
    if (isKvLease(current) && current.holder !== holder) return current
    const expiresAt = at + seconds * 1000
    const lease: KvLease = { holder, expiresAt: new Date(expiresAt).toISOString() }
    sql.set.run(key, JSON.stringify(lease), expiresAt)
    return lease
  })
  const release = db.transaction((key: string, holder: string) => {
    const row = db.query<{ value: string }, [string]>('SELECT value FROM kv WHERE key = ?').get(key)
    const current: unknown = row ? JSON.parse(row.value) : undefined
    if (!isKvLease(current) || current.holder !== holder) return false
    sql.delete.run(key)
    return true
  })
  const swap = db.transaction(
    (key: string, expected: unknown, value: unknown, expiresAt: number | null) => {
      const row = sql.get.get(key, Date.now())
      const same = row
        ? expected !== undefined && canonicalJson(JSON.parse(row.value)) === canonicalJson(expected)
        : expected === undefined
      if (!same) return false
      sql.set.run(key, JSON.stringify(value ?? null), expiresAt)
      return true
    },
  )
  return {
    async get(key) {
      const row = sql.get.get(key, Date.now())
      return row ? JSON.parse(row.value) : undefined
    },
    async set(key, value, ttlSeconds) {
      if (ttlSeconds !== undefined && !(ttlSeconds > 0)) throw new Error('ttlSeconds must be > 0')
      sql.set.run(
        key,
        JSON.stringify(value ?? null),
        ttlSeconds === undefined ? null : Date.now() + ttlSeconds * 1000,
      )
    },
    delete: async (key) => void sql.delete.run(key),
    sweep: async (now = new Date()) => sql.sweep.run(now.getTime()).changes,
    async acquireLease(key, holder, ttlSeconds, now = new Date()) {
      ttl(ttlSeconds)
      return acquire.immediate(key, holder, ttlSeconds, now.getTime())
    },
    releaseLease: async (key, holder) => release.immediate(key, holder),
    async compareAndSet(key, expected, value, ttlSeconds) {
      return swap.immediate(key, expected, value, ttl(ttlSeconds))
    },
  }
}
