import type {
  AnyConfigDocument,
  ConfigDocument,
  ConfigDocumentDataMap,
  ConfigDocumentType,
  ConfigRevision,
  ConfigStore,
  KvLease,
  KvStore,
} from '@holtkeeper/store'

import { type PgTimestamp, iso } from './rows.ts'
import type { Db } from './tables.ts'

interface ConfigDocumentRow<T extends ConfigDocumentType = ConfigDocumentType> {
  type: T
  id: string
  data: ConfigDocumentDataMap[T]
  version: number
  updated_at: PgTimestamp
  updated_by: string | null
}

/** A row of any document type, discriminated by `type` like `AnyConfigDocument`. */
type AnyConfigDocumentRow = {
  [T in ConfigDocumentType]: ConfigDocumentRow<T>
}[ConfigDocumentType]

type ConfigRevisionRow<T extends ConfigDocumentType = ConfigDocumentType> = Omit<
  ConfigDocumentRow<T>,
  'type' | 'id'
>

const toConfigDocument = <T extends ConfigDocumentType>(
  row: ConfigDocumentRow<T>,
): ConfigDocument<T> => ({
  type: row.type,
  id: row.id,
  data: row.data,
  version: row.version,
  updatedAt: iso(row.updated_at),
  ...(row.updated_by !== null && { updatedBy: row.updated_by }),
})

const toAnyConfigDocument = (row: AnyConfigDocumentRow): AnyConfigDocument => {
  switch (row.type) {
    case 'forge':
      return toConfigDocument(row)
    case 'group':
      return toConfigDocument(row)
    case 'repoTraits':
      return toConfigDocument(row)
    case 'schedule':
      return toConfigDocument(row)
    default:
      return toConfigDocument(row)
  }
}

const toConfigRevision = <T extends ConfigDocumentType>(
  row: ConfigRevisionRow<T>,
): ConfigRevision<T> => ({
  version: row.version,
  data: row.data,
  updatedAt: iso(row.updated_at),
  ...(row.updated_by !== null && { updatedBy: row.updated_by }),
})

/**
 * The Postgres `ConfigStore`: current versions in `config_documents`, older ones in
 * `config_history`. `put` holds a transaction-level advisory lock on `(type, id)`, so concurrent
 * writers of one document never assign the same version. Lists sort with the `C` collation, which
 * matches the code-unit order of `memoryStore`.
 */
export function postgresConfig(db: () => Promise<Db>, schema: string): ConfigStore {
  function list<T extends ConfigDocumentType>(type: T): Promise<ConfigDocument<T>[]>
  function list(): Promise<AnyConfigDocument[]>
  async function list(type?: ConfigDocumentType) {
    const { sql, t } = await db()
    const rows: AnyConfigDocumentRow[] = await sql`
      SELECT * FROM ${t.configDocuments}
      WHERE ${type ?? null}::text IS NULL OR type = ${type ?? null}::text
      ORDER BY type COLLATE "C", id COLLATE "C"`
    return rows.map(toAnyConfigDocument)
  }

  return {
    async put<T extends ConfigDocumentType>(input: Omit<ConfigDocument<T>, 'version'>) {
      const { sql, t } = await db()
      return sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`holtkeeper.config:${schema}:${input.type}:${input.id}`}, 0))`
        const archived: { version: number }[] = await tx`
          INSERT INTO ${t.configHistory} (type, id, version, data, updated_at, updated_by)
          SELECT type, id, version, data, updated_at, updated_by FROM ${t.configDocuments}
          WHERE type = ${input.type} AND id = ${input.id}
          RETURNING version`
        const [row]: ConfigDocumentRow<T>[] = await tx`
          INSERT INTO ${t.configDocuments} (type, id, data, version, updated_at, updated_by)
          VALUES (${input.type}, ${input.id}, ${tx.json(input.data)}, ${(archived[0]?.version ?? 0) + 1},
            ${input.updatedAt}, ${input.updatedBy ?? null})
          ON CONFLICT (type, id) DO UPDATE SET data = excluded.data, version = excluded.version,
            updated_at = excluded.updated_at, updated_by = excluded.updated_by
          RETURNING *`
        if (!row) throw new Error('config document was not stored')
        return toConfigDocument(row)
      })
    },
    async get<T extends ConfigDocumentType>(type: T, id: string) {
      const { sql, t } = await db()
      const [row]: ConfigDocumentRow<T>[] = await sql`
        SELECT * FROM ${t.configDocuments} WHERE type = ${type} AND id = ${id}`
      return row ? toConfigDocument(row) : undefined
    },
    list,
    async history<T extends ConfigDocumentType>(type: T, id: string) {
      const { sql, t } = await db()
      const rows: ConfigRevisionRow<T>[] = await sql`
        SELECT version, data, updated_at, updated_by FROM ${t.configHistory}
        WHERE type = ${type} AND id = ${id} ORDER BY version DESC`
      return rows.map(toConfigRevision)
    },
    async remove(type, id) {
      const { sql, t } = await db()
      await sql.begin(async (tx) => {
        await tx`DELETE FROM ${t.configDocuments} WHERE type = ${type} AND id = ${id}`
        await tx`DELETE FROM ${t.configHistory} WHERE type = ${type} AND id = ${id}`
      })
    },
  }
}

/** The Postgres `KvStore` in table `kv`; expired keys read as missing until `sweep` drops them. */
export function postgresKv(db: () => Promise<Db>): KvStore {
  return {
    async get(key) {
      const { sql, t } = await db()
      const [row]: { value: unknown }[] = await sql`
        SELECT value FROM ${t.kv}
        WHERE key = ${key} AND (expires_at IS NULL OR expires_at > ${new Date()}::timestamptz)`
      return row ? row.value : undefined
    },
    async set(key, value, ttlSeconds) {
      if (ttlSeconds !== undefined && !(ttlSeconds > 0)) throw new Error('ttlSeconds must be > 0')
      const { sql, t } = await db()
      const expiresAt = ttlSeconds === undefined ? null : new Date(Date.now() + ttlSeconds * 1000)
      await sql`
        INSERT INTO ${t.kv} (key, value, expires_at)
        VALUES (${key}, ${sql.json(value ?? null)}, ${expiresAt}::timestamptz)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`
    },
    async delete(key) {
      const { sql, t } = await db()
      await sql`DELETE FROM ${t.kv} WHERE key = ${key}`
    },
    async sweep(now = new Date()) {
      const { sql, t } = await db()
      const removed: unknown[] = await sql`
        DELETE FROM ${t.kv} WHERE expires_at IS NOT NULL AND expires_at <= ${now}::timestamptz
        RETURNING key`
      return removed.length
    },
    async acquireLease(key, holder, ttlSeconds, now = new Date()) {
      if (!(ttlSeconds > 0)) throw new Error('ttlSeconds must be > 0')
      const { sql, t } = await db()
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000)
      const lease: KvLease = { holder, expiresAt: expiresAt.toISOString() }
      for (;;) {
        const [taken]: { value: KvLease }[] = await sql`
          INSERT INTO ${t.kv} AS kv (key, value, expires_at)
          VALUES (${key}, ${sql.json(lease)}, ${expiresAt}::timestamptz)
          ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
          WHERE kv.expires_at <= ${now}::timestamptz OR kv.value->>'holder' = ${holder}
          RETURNING value`
        if (taken) return taken.value
        const [held]: { value: KvLease }[] = await sql`
          SELECT value FROM ${t.kv} WHERE key = ${key}`
        if (held) return held.value
      }
    },
    async releaseLease(key, holder) {
      const { sql, t } = await db()
      const removed: unknown[] = await sql`
        DELETE FROM ${t.kv} WHERE key = ${key} AND value->>'holder' = ${holder} RETURNING key`
      return removed.length > 0
    },
    async compareAndSet(key, expected, value, ttlSeconds) {
      if (ttlSeconds !== undefined && !(ttlSeconds > 0)) throw new Error('ttlSeconds must be > 0')
      const { sql, t } = await db()
      const now = new Date()
      const expiresAt =
        ttlSeconds === undefined ? null : new Date(now.getTime() + ttlSeconds * 1000)
      const written: unknown[] =
        expected === undefined
          ? await sql`
              INSERT INTO ${t.kv} AS kv (key, value, expires_at)
              VALUES (${key}, ${sql.json(value ?? null)}, ${expiresAt}::timestamptz)
              ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
              WHERE kv.expires_at IS NOT NULL AND kv.expires_at <= ${now}::timestamptz
              RETURNING key`
          : await sql`
              UPDATE ${t.kv} SET value = ${sql.json(value ?? null)}, expires_at = ${expiresAt}::timestamptz
              WHERE key = ${key} AND value = ${sql.json(expected)}::jsonb
                AND (expires_at IS NULL OR expires_at > ${now}::timestamptz)
              RETURNING key`
      return written.length > 0
    },
  }
}
