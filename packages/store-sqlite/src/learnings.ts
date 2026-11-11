import type { Database } from 'bun:sqlite'

import type { LearningCandidate, LearningStore, ReactionSignal } from '@holtkeeper/store'
import {
  byLearningUpdate,
  matchesLearningFilter,
  reactionsOf,
  sumReactions,
} from '@holtkeeper/store'

interface DataRow {
  data: string
}

const toCandidate = (row: DataRow): LearningCandidate => JSON.parse(row.data)
const toSignal = (row: DataRow): ReactionSignal => JSON.parse(row.data)

/**
 * The SQLite `LearningStore`: one JSON row per candidate in `learnings`, handled sources in
 * `learning_claims`, reaction counts in `review_reactions`.
 */
export function sqliteLearnings(db: Database): LearningStore {
  const sql = {
    get: db.query<DataRow, [string]>('SELECT data FROM learnings WHERE id = ?'),
    all: db.query<DataRow, []>('SELECT data FROM learnings'),
    find: db.query<DataRow, [string, string]>(
      'SELECT data FROM learnings WHERE repo = ? AND key = ? ORDER BY created_at, id LIMIT 1',
    ),
    upsert: db.prepare(
      `INSERT INTO learnings (id, repo, key, created_at, data) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET repo = excluded.repo, key = excluded.key,
         created_at = excluded.created_at, data = excluded.data`,
    ),
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
      return row ? toCandidate(row) : undefined
    },
    list: async (filter) =>
      sql.all
        .all()
        .map(toCandidate)
        .filter((candidate) => matchesLearningFilter(candidate, filter))
        .toSorted(byLearningUpdate),
    async find(repo, key) {
      const row = sql.find.get(repo, key)
      return row ? toCandidate(row) : undefined
    },
    async put(candidate) {
      sql.upsert.run(
        candidate.id,
        candidate.repo,
        candidate.key,
        candidate.createdAt,
        JSON.stringify(candidate),
      )
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
      reactionsOf(sql.reactionsOfRepo.all(filter.repo).map(toSignal), filter),
  }
}
