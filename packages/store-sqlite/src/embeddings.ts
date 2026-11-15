import type { Database } from 'bun:sqlite'

import { decodeVector, encodeVector } from '@holtkeeper/embed'
import type { EmbeddingStore, StoredEmbedding } from '@holtkeeper/store'

interface EmbeddingRow {
  subject: string
  model: string
  hash: string
  vector: Uint8Array
  updated_at: string
}

const toEmbedding = (row: EmbeddingRow): StoredEmbedding => ({
  subject: row.subject,
  model: row.model,
  hash: row.hash,
  vector: decodeVector(row.vector),
  updatedAt: row.updated_at,
})

/** The SQLite `EmbeddingStore`: one row per (subject, model) in `embeddings`, vectors as BLOBs. */
export function sqliteEmbeddings(db: Database): EmbeddingStore {
  const sql = {
    upsert: db.prepare(
      `INSERT INTO embeddings (subject, model, hash, vector, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (subject, model) DO UPDATE SET
         hash = excluded.hash, vector = excluded.vector, updated_at = excluded.updated_at`,
    ),
    // substr instead of LIKE: subjects may hold `%` and `_`.
    list: db.query<EmbeddingRow, [string, string, string]>(
      `SELECT subject, model, hash, vector, updated_at FROM embeddings
       WHERE model = ? AND substr(subject, 1, length(?)) = ? ORDER BY subject`,
    ),
    remove: db.prepare('DELETE FROM embeddings WHERE subject = ?'),
    prune: db.prepare('DELETE FROM embeddings WHERE model <> ?'),
  }
  const put = db.transaction((entries: readonly Omit<StoredEmbedding, 'updatedAt'>[]) => {
    const at = new Date().toISOString()
    for (const entry of entries)
      sql.upsert.run(entry.subject, entry.model, entry.hash, encodeVector(entry.vector), at)
  })
  const remove = db.transaction((subjects: readonly string[]) => {
    for (const subject of subjects) sql.remove.run(subject)
  })
  return {
    async put(entries) {
      put(entries)
    },
    async list({ model, prefix = '' }) {
      return sql.list.all(model, prefix, prefix).map(toEmbedding)
    },
    async remove(subjects) {
      remove(subjects)
    },
    async pruneModels(keep) {
      return sql.prune.run(keep).changes
    },
  }
}
