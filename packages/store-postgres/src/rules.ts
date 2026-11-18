import type { RuleStore } from '@holtkeeper/store'
import { RuleVersionConflictError, ruleContent } from '@holtkeeper/store'
import type { SQL } from 'bun'

import { type RuleHistoryRow, type RuleRow, toRule, toRuleRevision } from './rows.ts'
import { RANK_WEIGHTS, prefixTsQuery, searchTerms } from './search.ts'
import type { Db } from './tables.ts'

const columns = (sql: SQL) => sql`r.id, r.title, r.body, r.description, r.scope, r.files,
  r.agents, r.always_apply, r.author, r.created_at, r.updated_at, r.updated_by, r.version`

const jsonOrNull = (sql: SQL, value: unknown) => (value === undefined ? null : sql.json(value))

/** The SQL `RuleStore`: rows in `rules`, versions in `rule_history`, `tsvector` search. */
export function postgresRules(db: () => Promise<Db>, schema: string): RuleStore {
  return {
    async put(input, expectedVersion) {
      const { sql, t } = await db()
      return sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`holtkeeper.rules:${schema}:${input.id}`}, 0))`
        const [row]: RuleRow[] = await tx`
          SELECT ${columns(tx)} FROM ${t.rules} r WHERE r.id = ${input.id}`
        const previous = row ? toRule(row) : undefined
        const stored = previous?.version ?? 0
        if (expectedVersion !== undefined && expectedVersion !== stored)
          throw new RuleVersionConflictError(input.id, stored)
        if (previous) {
          await tx`
            INSERT INTO ${t.ruleHistory} (rule_id, version, content, edited_by, edited_at)
            VALUES (${previous.id}, ${previous.version}, ${tx.json(ruleContent(previous))},
              ${previous.updatedBy ?? previous.author}, ${previous.updatedAt})`
        }
        const [saved]: RuleRow[] = await tx`
          INSERT INTO ${t.rules} AS r (id, title, body, description, scope, files, agents,
            always_apply, author, created_at, updated_at, updated_by, version)
          VALUES (${input.id}, ${input.title}, ${input.body}, ${input.description ?? null},
            ${tx.json(input.scope)}, ${jsonOrNull(tx, input.files)}, ${jsonOrNull(tx, input.agents)},
            ${input.alwaysApply ?? null}, ${input.author}, ${input.createdAt}, ${input.updatedAt},
            ${input.updatedBy ?? null}, ${stored + 1})
          ON CONFLICT (id) DO UPDATE SET title = excluded.title, body = excluded.body,
            description = excluded.description, scope = excluded.scope, files = excluded.files,
            agents = excluded.agents, always_apply = excluded.always_apply,
            author = excluded.author, created_at = excluded.created_at,
            updated_at = excluded.updated_at, updated_by = excluded.updated_by,
            version = excluded.version
          RETURNING ${columns(tx)}`
        if (!saved) throw new Error('rule upsert returned nothing')
        return toRule(saved)
      })
    },
    async get(id) {
      const { sql, t } = await db()
      const [row]: RuleRow[] =
        await sql`SELECT ${columns(sql)} FROM ${t.rules} r WHERE r.id = ${id}`
      return row ? toRule(row) : undefined
    },
    async list() {
      const { sql, t } = await db()
      const rows: RuleRow[] = await sql`
        SELECT ${columns(sql)} FROM ${t.rules} r
        ORDER BY lower(r.title) COLLATE "C", r.id COLLATE "C"`
      return rows.map(toRule)
    },
    async history(id) {
      const { sql, t } = await db()
      const rows: RuleHistoryRow[] = await sql`
        SELECT version, content, edited_by, edited_at FROM ${t.ruleHistory}
        WHERE rule_id = ${id} ORDER BY version DESC`
      return rows.map(toRuleRevision)
    },
    async remove(id) {
      const { sql, t } = await db()
      await sql`DELETE FROM ${t.rules} WHERE id = ${id}`
    },
    async search(text, limit = 20) {
      const terms = searchTerms(text)
      if (!terms.length) return []
      const { sql, t } = await db()
      const rows: (RuleRow & { score: number })[] = await sql`
        WITH q AS (SELECT ${prefixTsQuery(sql, t, terms)} AS query)
        SELECT ${columns(sql)},
          ts_rank(${sql.array([...RANK_WEIGHTS], 'FLOAT4')}, r.search, q.query) AS score
        FROM ${t.rules} r, q
        WHERE r.search @@ q.query
        ORDER BY score DESC, r.updated_at DESC, r.id COLLATE "C"
        LIMIT ${limit}`
      return rows.map(({ score, ...row }) => ({ rule: toRule(row), score }))
    },
  }
}
