import type { Learning, LearningFilter, LearningStore, ReactionSignal } from '@holtkeeper/store'
import { reactionsOf, sumReactions } from '@holtkeeper/store'
import type { SQL } from 'bun'

import { RANK_WEIGHTS, prefixTsQuery, searchTerms } from './search.ts'
import type { Db } from './tables.ts'

const jsonList = (sql: SQL, value: readonly string[] | undefined) =>
  value === undefined ? null : sql.json([...value])

/** The `WHERE` condition of a learning filter, over rows aliased `l`. */
function where(sql: SQL, filter: LearningFilter = {}) {
  const statuses = jsonList(sql, filter.status)
  const origins = jsonList(sql, filter.origin)
  return sql`
    (${statuses}::jsonb IS NULL OR l.status IN (SELECT jsonb_array_elements_text(${statuses}::jsonb)))
    AND (${origins}::jsonb IS NULL OR l.origin IN (SELECT jsonb_array_elements_text(${origins}::jsonb)))`
}

/**
 * The SQL `LearningStore`: one JSON row per learning in `learnings` (status, origin, key and text
 * also as columns, the text indexed as a `tsvector`), handled sources in `learning_claims`,
 * reaction counts in `review_reactions`.
 */
export function postgresLearnings(db: () => Promise<Db>): LearningStore {
  return {
    async get(id) {
      const { sql, t } = await db()
      const [row]: { data: Learning }[] = await sql`
        SELECT data FROM ${t.learnings} WHERE id = ${id}`
      return row?.data
    },
    async list(filter) {
      const { sql, t } = await db()
      const rows: { data: Learning }[] = await sql`
        SELECT l.data FROM ${t.learnings} l WHERE ${where(sql, filter)}
        ORDER BY l.updated_at COLLATE "C" DESC, l.id COLLATE "C"`
      return rows.map((row) => row.data)
    },
    async find(key) {
      const { sql, t } = await db()
      const [row]: { data: Learning }[] = await sql`
        SELECT data FROM ${t.learnings} WHERE key = ${key}
        ORDER BY created_at COLLATE "C", id COLLATE "C" LIMIT 1`
      return row?.data
    },
    async put(learning) {
      const { sql, t } = await db()
      await sql`
        INSERT INTO ${t.learnings} (id, key, text, status, origin, created_at, updated_at, data)
        VALUES (${learning.id}, ${learning.key}, ${learning.text}, ${learning.status},
          ${learning.origin}, ${learning.createdAt}, ${learning.updatedAt}, ${sql.json(learning)})
        ON CONFLICT (id) DO UPDATE SET key = excluded.key, text = excluded.text,
          status = excluded.status, origin = excluded.origin, created_at = excluded.created_at,
          updated_at = excluded.updated_at, data = excluded.data`
    },
    async remove(id) {
      const { sql, t } = await db()
      await sql`DELETE FROM ${t.learnings} WHERE id = ${id}`
    },
    async search(text, filter, limit = 20) {
      const terms = searchTerms(text)
      if (!terms.length) return []
      const { sql, t } = await db()
      const rows: { data: Learning; score: number }[] = await sql`
        WITH q AS (SELECT ${prefixTsQuery(sql, t, terms)} AS query)
        SELECT l.data, ts_rank(${sql.array([...RANK_WEIGHTS], 'FLOAT4')}, l.search, q.query) AS score
        FROM ${t.learnings} l, q
        WHERE l.search @@ q.query AND ${where(sql, filter)}
        ORDER BY score DESC, l.updated_at COLLATE "C" DESC, l.id COLLATE "C"
        LIMIT ${limit}`
      return rows.map((row) => ({ learning: row.data, score: row.score }))
    },
    async claim(key, at) {
      const { sql, t } = await db()
      const rows = await sql`
        INSERT INTO ${t.learningClaims} (key, at) VALUES (${key}, ${at})
        ON CONFLICT DO NOTHING RETURNING key`
      return rows.length > 0
    },
    async release(key) {
      const { sql, t } = await db()
      await sql`DELETE FROM ${t.learningClaims} WHERE key = ${key}`
    },
    async putReactions(signal) {
      const { sql, t } = await db()
      await sql`
        INSERT INTO ${t.reviewReactions} (repo, merge_request, note_id, data)
        VALUES (${signal.repo}, ${signal.mergeRequest}, ${signal.noteId}, ${sql.json(signal)})
        ON CONFLICT (repo, merge_request, note_id) DO UPDATE SET data = excluded.data`
    },
    async reactionTotals(filter) {
      const { sql, t } = await db()
      const rows: { data: ReactionSignal }[] = await sql`SELECT data FROM ${t.reviewReactions}`
      return sumReactions(
        rows.map((row) => row.data),
        filter?.repos,
      )
    },
    async reactions(filter) {
      const { sql, t } = await db()
      const rows: { data: ReactionSignal }[] =
        filter?.repo === undefined
          ? await sql`SELECT data FROM ${t.reviewReactions}`
          : await sql`SELECT data FROM ${t.reviewReactions} WHERE repo = ${filter.repo}`
      return reactionsOf(
        rows.map((row) => row.data),
        filter,
      )
    },
  }
}
