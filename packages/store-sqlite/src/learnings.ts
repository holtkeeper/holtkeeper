import type { Database } from 'bun:sqlite'

import type { Learning, LearningFilter, LearningStore, ReactionSignal } from '@holtkeeper/store'
import { reactionsOf, sumReactions } from '@holtkeeper/store'

import { ftsQuery } from './search.ts'

interface DataRow {
  data: string
}

type FilterParams = [string | null, string | null]

const toLearning = (row: DataRow): Learning => JSON.parse(row.data)
const toSignal = (row: DataRow): ReactionSignal => JSON.parse(row.data)

const filterParams = (filter: LearningFilter = {}): FilterParams => [
  filter.status ? JSON.stringify(filter.status) : null,
  filter.origin ? JSON.stringify(filter.origin) : null,
]

const filterSql = `
  (?1 IS NULL OR l.status IN (SELECT value FROM json_each(?1)))
  AND (?2 IS NULL OR l.origin IN (SELECT value FROM json_each(?2)))`

/**
 * The SQLite `LearningStore`: one JSON row per learning in `learnings` (status, origin, key and
 * text also as columns, the text indexed by FTS5), handled sources in `learning_claims`, reaction
 * counts in `review_reactions`.
 */
export function sqliteLearnings(db: Database): LearningStore {
  const sql = {
    get: db.query<DataRow, [string]>('SELECT data FROM learnings WHERE id = ?'),
    list: db.query<DataRow, FilterParams>(
      `SELECT l.data FROM learnings l WHERE ${filterSql} ORDER BY l.updated_at DESC, l.id`,
    ),
    find: db.query<DataRow, [string]>(
      'SELECT data FROM learnings WHERE key = ? ORDER BY created_at, id LIMIT 1',
    ),
    search: db.query<DataRow & { rank: number }, [...FilterParams, string, number]>(
      `SELECT l.data, bm25(learnings_fts) AS rank
       FROM learnings_fts JOIN learnings l ON l.seq = learnings_fts.rowid
       WHERE learnings_fts MATCH ?3 AND ${filterSql}
       ORDER BY rank, l.updated_at DESC, l.id LIMIT ?4`,
    ),
    upsert: db.prepare(
      `INSERT INTO learnings (id, key, text, status, origin, created_at, updated_at, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET key = excluded.key, text = excluded.text,
         status = excluded.status, origin = excluded.origin, created_at = excluded.created_at,
         updated_at = excluded.updated_at, data = excluded.data`,
    ),
    remove: db.prepare('DELETE FROM learnings WHERE id = ?'),
    claim: db.prepare('INSERT INTO learning_claims (key, at) VALUES (?, ?) ON CONFLICT DO NOTHING'),
    release: db.prepare('DELETE FROM learning_claims WHERE key = ?'),
    putReactions: db.prepare(
      `INSERT INTO review_reactions (repo, merge_request, note_id, data) VALUES (?, ?, ?, ?)
       ON CONFLICT (repo, merge_request, note_id) DO UPDATE SET data = excluded.data`,
    ),
    reactions: db.query<DataRow, []>('SELECT data FROM review_reactions'),
    reactionsOfRepo: db.query<DataRow, [string]>(
      'SELECT data FROM review_reactions WHERE repo = ?',
    ),
  }
  return {
    async get(id) {
      const row = sql.get.get(id)
      return row ? toLearning(row) : undefined
    },
    list: async (filter) => sql.list.all(...filterParams(filter)).map(toLearning),
    async find(key) {
      const row = sql.find.get(key)
      return row ? toLearning(row) : undefined
    },
    async put(learning) {
      sql.upsert.run(
        learning.id,
        learning.key,
        learning.text,
        learning.status,
        learning.origin,
        learning.createdAt,
        learning.updatedAt,
        JSON.stringify(learning),
      )
    },
    async remove(id) {
      sql.remove.run(id)
    },
    async search(text, filter, limit = 20) {
      const query = ftsQuery(text)
      if (!query) return []
      return sql.search
        .all(...filterParams(filter), query, limit)
        .map((row) => ({ learning: toLearning(row), score: -row.rank }))
    },
    claim: async (key, at) => sql.claim.run(key, at).changes > 0,
    async release(key) {
      sql.release.run(key)
    },
    async putReactions(signal) {
      sql.putReactions.run(signal.repo, signal.mergeRequest, signal.noteId, JSON.stringify(signal))
    },
    reactionTotals: async (filter) =>
      sumReactions(sql.reactions.all().map(toSignal), filter?.repos),
    reactions: async (filter) =>
      reactionsOf(
        (filter?.repo === undefined
          ? sql.reactions.all()
          : sql.reactionsOfRepo.all(filter.repo)
        ).map(toSignal),
        filter,
      ),
  }
}
