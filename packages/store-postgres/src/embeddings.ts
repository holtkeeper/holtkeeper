import { decodeVector, encodeVector } from '@holtkeeper/embed'
import type { EmbeddingStore, StoredEmbedding } from '@holtkeeper/store'

import { iso, type PgTimestamp } from './rows.ts'
import type { Db } from './tables.ts'

interface EmbeddingRow {
  subject: string
  model: string
  hash: string
  vector: Uint8Array
  updated_at: PgTimestamp
}

/** Rows per `INSERT`: keeps a statement well under the bind parameter limit. */
const CHUNK = 500

/**
 * The Postgres `EmbeddingStore`: one row per (subject, model) in `embeddings`, vectors as `bytea`
 * of little-endian float32. Similarity is computed by the caller, so no extension is needed.
 */
export function postgresEmbeddings(db: () => Promise<Db>): EmbeddingStore {
  return {
    async put(entries) {
      if (!entries.length) return
      const { sql, t } = await db()
      const at = new Date().toISOString()
      // One statement cannot upsert the same key twice; the last entry for a key wins.
      const rows = [
        ...new Map(
          entries.map((entry) => [
            `${entry.subject}\u0000${entry.model}`,
            {
              subject: entry.subject,
              model: entry.model,
              hash: entry.hash,
              vector: encodeVector(entry.vector),
              updated_at: at,
            },
          ]),
        ).values(),
      ]
      await sql.begin(async (tx) => {
        for (let start = 0; start < rows.length; start += CHUNK) {
          // oxlint-disable-next-line no-await-in-loop -- chunks of one transaction run in order
          await tx`
            INSERT INTO ${t.embeddings}
              ${tx(rows.slice(start, start + CHUNK), 'subject', 'model', 'hash', 'vector', 'updated_at')}
            ON CONFLICT (subject, model) DO UPDATE SET
              hash = excluded.hash, vector = excluded.vector, updated_at = excluded.updated_at`
        }
      })
    },
    async list({ model, prefix = '' }) {
      const { sql, t } = await db()
      const rows: EmbeddingRow[] = await sql`
        SELECT subject, model, hash, vector, updated_at FROM ${t.embeddings}
        WHERE model = ${model} AND starts_with(subject, ${prefix})
        ORDER BY subject COLLATE "C"`
      return rows.map((row): StoredEmbedding => ({
        subject: row.subject,
        model: row.model,
        hash: row.hash,
        vector: decodeVector(row.vector),
        updatedAt: iso(row.updated_at),
      }))
    },
    async remove(subjects) {
      if (!subjects.length) return
      const { sql, t } = await db()
      await sql`DELETE FROM ${t.embeddings} WHERE subject IN ${sql([...subjects])}`
    },
    async pruneModels(keep) {
      const { sql, t } = await db()
      const deleted = await sql`DELETE FROM ${t.embeddings} WHERE model <> ${keep} RETURNING model`
      return deleted.length
    },
  }
}
