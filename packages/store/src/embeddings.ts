import type { EmbeddingStore, StoredEmbedding } from './types.ts'

const copy = (embedding: StoredEmbedding): StoredEmbedding => ({
  ...embedding,
  vector: embedding.vector.slice(),
})

const key = (subject: string, model: string) => `${subject}\u0000${model}`

/** The in-memory `EmbeddingStore`. */
export function memoryEmbeddings(): EmbeddingStore {
  const rows = new Map<string, StoredEmbedding>()
  return {
    async put(entries) {
      const updatedAt = new Date().toISOString()
      for (const entry of entries)
        rows.set(key(entry.subject, entry.model), copy({ ...entry, updatedAt }))
    },
    async list({ model, prefix = '' }) {
      return [...rows.values()]
        .filter((row) => row.model === model && row.subject.startsWith(prefix))
        .toSorted((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0))
        .map(copy)
    },
    async remove(subjects) {
      const gone = new Set(subjects)
      for (const [id, row] of rows) if (gone.has(row.subject)) rows.delete(id)
    },
    async pruneModels(keep) {
      let removed = 0
      for (const [id, row] of rows)
        if (row.model !== keep) {
          rows.delete(id)
          removed++
        }
      return removed
    },
  }
}
