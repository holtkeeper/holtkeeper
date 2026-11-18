import type { Database } from 'bun:sqlite'

import type { Rule, RuleInput, RuleRevision, RuleStore } from '@holtkeeper/store'
import { RuleVersionConflictError, ruleContent } from '@holtkeeper/store'

import { ftsQuery } from './search.ts'

interface RuleRow {
  id: string
  title: string
  body: string
  description: string | null
  scope: string
  files: string | null
  agents: string | null
  always_apply: number | null
  author: string
  created_at: string
  updated_at: string
  updated_by: string | null
  version: number
}

interface HistoryRow {
  version: number
  content: string
  edited_by: string
  edited_at: string
}

const toRule = (r: RuleRow): Rule => ({
  id: r.id,
  title: r.title,
  body: r.body,
  scope: JSON.parse(r.scope),
  ...(r.files !== null && { files: JSON.parse(r.files) }),
  ...(r.agents !== null && { agents: JSON.parse(r.agents) }),
  ...(r.description !== null && { description: r.description }),
  ...(r.always_apply !== null && { alwaysApply: r.always_apply === 1 }),
  author: r.author,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(r.updated_by !== null && { updatedBy: r.updated_by }),
  version: r.version,
})

const json = (value: unknown) => (value === undefined ? null : JSON.stringify(value))

/** The SQLite `RuleStore`: rows in `rules`, versions in `rule_history`, FTS5 search. */
export function sqliteRules(db: Database): RuleStore {
  const sql = {
    get: db.query<RuleRow, [string]>('SELECT * FROM rules WHERE id = ?'),
    upsert: db.query<
      RuleRow,
      [
        string,
        string,
        string,
        string | null,
        string,
        string | null,
        string | null,
        number | null,
        string,
        string,
        string,
        string | null,
        number,
      ]
    >(
      `INSERT INTO rules (id, title, body, description, scope, files, agents, always_apply, author,
         created_at, updated_at, updated_by, version)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
       ON CONFLICT (id) DO UPDATE SET title = excluded.title, body = excluded.body,
         description = excluded.description, scope = excluded.scope, files = excluded.files,
         agents = excluded.agents, always_apply = excluded.always_apply, author = excluded.author,
         created_at = excluded.created_at, updated_at = excluded.updated_at,
         updated_by = excluded.updated_by, version = excluded.version
       RETURNING *`,
    ),
    addRevision: db.prepare(
      'INSERT INTO rule_history (rule_id, version, content, edited_by, edited_at) VALUES (?, ?, ?, ?, ?)',
    ),
    history: db.query<HistoryRow, [string]>(
      'SELECT * FROM rule_history WHERE rule_id = ? ORDER BY version DESC',
    ),
    list: db.query<RuleRow, []>('SELECT * FROM rules ORDER BY lower(title), id'),
    search: db.query<RuleRow & { rank: number }, [string, number]>(
      `SELECT r.*, bm25(rules_fts, 5.0, 3.0, 1.0) AS rank
       FROM rules_fts JOIN rules r ON r.seq = rules_fts.rowid
       WHERE rules_fts MATCH ?1
       ORDER BY rank, r.updated_at DESC, r.id LIMIT ?2`,
    ),
    removeHistory: db.prepare('DELETE FROM rule_history WHERE rule_id = ?'),
    remove: db.prepare('DELETE FROM rules WHERE id = ?'),
  }

  const put = db.transaction((input: RuleInput, expectedVersion?: number): Rule => {
    const row = sql.get.get(input.id)
    const previous = row ? toRule(row) : undefined
    const stored = previous?.version ?? 0
    if (expectedVersion !== undefined && expectedVersion !== stored)
      throw new RuleVersionConflictError(input.id, stored)
    if (previous)
      sql.addRevision.run(
        previous.id,
        previous.version,
        JSON.stringify(ruleContent(previous)),
        previous.updatedBy ?? previous.author,
        previous.updatedAt,
      )
    const saved = sql.upsert.get(
      input.id,
      input.title,
      input.body,
      input.description ?? null,
      JSON.stringify(input.scope),
      json(input.files),
      json(input.agents),
      input.alwaysApply === undefined ? null : Number(input.alwaysApply),
      input.author,
      input.createdAt,
      input.updatedAt,
      input.updatedBy ?? null,
      stored + 1,
    )
    if (!saved) throw new Error('rule upsert returned nothing')
    return toRule(saved)
  })

  const remove = db.transaction((id: string) => {
    sql.removeHistory.run(id)
    sql.remove.run(id)
  })

  return {
    put: async (rule, expectedVersion) => put.immediate(rule, expectedVersion),
    async get(id) {
      const row = sql.get.get(id)
      return row ? toRule(row) : undefined
    },
    list: async () => sql.list.all().map(toRule),
    history: async (id) =>
      sql.history.all(id).map((r): RuleRevision => ({
        ...JSON.parse(r.content),
        version: r.version,
        editedBy: r.edited_by,
        editedAt: r.edited_at,
      })),
    async remove(id) {
      remove.immediate(id)
    },
    async search(text, limit = 20) {
      const query = ftsQuery(text)
      if (!query) return []
      return sql.search.all(query, limit).map((row) => ({ rule: toRule(row), score: -row.rank }))
    },
  }
}
