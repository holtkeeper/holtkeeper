import type { LearningCandidate, LearningStore, ReactionSignal } from '@holtkeeper/store'
import { matchesLearningFilter, reactionsOf, sumReactions } from '@holtkeeper/store'

import type { Db } from './tables.ts'

/**
 * The SQL `LearningStore`: one JSON row per candidate in `learnings`, handled sources in
 * `learning_claims`, reaction counts in `review_reactions`.
 */
export function postgresLearnings(db: () => Promise<Db>): LearningStore {
  return {
    async get(id) {
      const { sql, t } = await db()
      const [row]: { data: LearningCandidate }[] = await sql`
        SELECT data FROM ${t.learnings} WHERE id = ${id}`
      return row?.data
    },
    async list(filter) {
      const { sql, t } = await db()
      const rows: { data: LearningCandidate }[] = await sql`
        SELECT data FROM ${t.learnings}
        ORDER BY updated_at COLLATE "C" DESC, id COLLATE "C"`
      return rows.map((row) => row.data).filter((row) => matchesLearningFilter(row, filter))
    },
    async find(repo, key) {
      const { sql, t } = await db()
      const [row]: { data: LearningCandidate }[] = await sql`
        SELECT data FROM ${t.learnings} WHERE repo = ${repo} AND key = ${key}
        ORDER BY created_at COLLATE "C", id COLLATE "C" LIMIT 1`
      return row?.data
    },
    async put(candidate) {
      const { sql, t } = await db()
      await sql`
        INSERT INTO ${t.learnings} (id, repo, key, created_at, updated_at, data)
        VALUES (${candidate.id}, ${candidate.repo}, ${candidate.key}, ${candidate.createdAt},
          ${candidate.updatedAt}, ${sql.json(candidate)})
        ON CONFLICT (id) DO UPDATE SET repo = excluded.repo, key = excluded.key,
          created_at = excluded.created_at, updated_at = excluded.updated_at, data = excluded.data`
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
      const rows: { data: ReactionSignal }[] = await sql`
        SELECT data FROM ${t.reviewReactions} WHERE repo = ${filter.repo}`
      return reactionsOf(
        rows.map((row) => row.data),
        filter,
      )
    },
  }
}
