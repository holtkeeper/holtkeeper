import type { KnowledgeEntryInput, KnowledgeFilter, KnowledgeStore } from '@holtkeeper/store'
import { knowledgeWords } from '@holtkeeper/store'
import type { SQL } from 'bun'

import {
  type KnowledgeHistoryRow,
  type KnowledgeRow,
  knowledgeContent,
  toKnowledgeEntry,
  toKnowledgeRevision,
} from './rows.ts'
import type { Db } from './tables.ts'

/**
 * Distinct lowercase words of a search text. Each becomes a quoted prefix operand of the
 * `tsquery`, so operators, quotes and punctuation in the input never reach the query parser.
 */
export const searchTerms = (text: string): string[] => [...new Set(knowledgeWords(text))]

/** `ts_rank` weights in `{D, C, B, A}` order: title (A) 5, tags (B) 3, body (C) 1, as in SQLite. */
export const RANK_WEIGHTS = [0, 0.2, 0.6, 1] as const

/** Topics and package names, indexed with weight B. */
export const knowledgeTags = (entry: KnowledgeEntryInput) =>
  [...entry.topics, ...(entry.packages ?? []).map((pkg) => pkg.name)].join(' ')

/** The values `knowledgeWhere` binds for a filter; `null` means the field is not filtered. */
export interface KnowledgeFilterParams {
  statuses: string[] | null
  kinds: string[] | null
  topic: string | null
  scope: string | null
  packageName: string | null
  ecosystem: string | null
}

const list = <T>(value: T | T[] | undefined) => (value === undefined ? null : [value].flat())

/** Normalizes a `KnowledgeFilter`: single values become lists and `npm:react` splits in two. */
export function knowledgeFilterParams(filter: KnowledgeFilter = {}): KnowledgeFilterParams {
  const pkg = filter.package
  const separator = pkg?.indexOf(':') ?? -1
  return {
    statuses: list(filter.status),
    kinds: list(filter.kind),
    topic: filter.topic ?? null,
    scope: filter.scope ?? null,
    packageName: pkg === undefined ? null : separator > 0 ? pkg.slice(separator + 1) : pkg,
    ecosystem: pkg !== undefined && separator > 0 ? pkg.slice(0, separator) : null,
  }
}

const columns = (sql: SQL) => sql`k.id, k.title, k.body, k.kind, k.status, k.source, k.author,
  k.scope, k.topics, k.applies_to, k.packages, k.evidence, k.supersedes, k.created_at, k.updated_at,
  k.updated_by, k.version`

const jsonList = (sql: SQL, value: string[] | null) => (value === null ? null : sql.json(value))

/** The `WHERE` condition of a knowledge filter, over rows aliased `k`. */
function where(sql: SQL, filter?: KnowledgeFilter) {
  const p = knowledgeFilterParams(filter)
  return sql`
    (${jsonList(sql, p.statuses)}::jsonb IS NULL
      OR k.status IN (SELECT jsonb_array_elements_text(${jsonList(sql, p.statuses)}::jsonb)))
    AND (${jsonList(sql, p.kinds)}::jsonb IS NULL
      OR k.kind IN (SELECT jsonb_array_elements_text(${jsonList(sql, p.kinds)}::jsonb)))
    AND (${p.topic}::text IS NULL OR EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(k.topics) AS topic (value)
      WHERE lower(topic.value) = lower(${p.topic}::text)))
    AND (${p.scope}::text IS NULL
      OR (lower(${p.scope}::text) = 'all' AND k.scope -> 'all' = 'true'::jsonb)
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(
          COALESCE(k.scope -> 'groups', '[]'::jsonb) || COALESCE(k.scope -> 'repos', '[]'::jsonb)
        ) AS pattern (value)
        WHERE strpos(lower(pattern.value), lower(${p.scope}::text)) > 0))
    AND (${p.packageName}::text IS NULL OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(k.packages, '[]'::jsonb)) AS pkg (value)
      WHERE pkg.value ->> 'name' = ${p.packageName}::text
        AND (${p.ecosystem}::text IS NULL OR pkg.value ->> 'ecosystem' = ${p.ecosystem}::text)))`
}

/** The SQL `KnowledgeStore`: rows in `knowledge`, versions in `knowledge_history`, `tsvector` search. */
export function postgresKnowledge(db: () => Promise<Db>, schema: string): KnowledgeStore {
  return {
    async put(input) {
      const { sql, t } = await db()
      return sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`holtkeeper.knowledge:${schema}:${input.id}`}, 0))`
        const [row]: KnowledgeRow[] = await tx`
          SELECT ${columns(tx)} FROM ${t.knowledge} k WHERE k.id = ${input.id}`
        const previous = row ? toKnowledgeEntry(row) : undefined
        if (previous) {
          await tx`
            INSERT INTO ${t.knowledgeHistory} (entry_id, version, content, edited_by, edited_at)
            VALUES (${previous.id}, ${previous.version}, ${tx.json(knowledgeContent(previous))},
              ${previous.updatedBy ?? previous.author}, ${previous.updatedAt})`
        }
        const [stored]: KnowledgeRow[] = await tx`
          INSERT INTO ${t.knowledge} AS k (id, title, body, kind, status, source, author, scope, topics,
            applies_to, packages, evidence, supersedes, tags, created_at, updated_at, updated_by, version)
          VALUES (${input.id}, ${input.title}, ${input.body}, ${input.kind}, ${input.status},
            ${input.source}, ${input.author}, ${tx.json(input.scope)}, ${tx.json(input.topics)},
            ${tx.json(input.appliesTo)}, ${input.packages ? tx.json(input.packages) : null},
            ${tx.json(input.evidence)}, ${input.supersedes ?? null}, ${knowledgeTags(input)},
            ${input.createdAt}, ${input.updatedAt}, ${input.updatedBy ?? null},
            ${(previous?.version ?? 0) + 1})
          ON CONFLICT (id) DO UPDATE SET title = excluded.title, body = excluded.body,
            kind = excluded.kind, status = excluded.status, source = excluded.source,
            author = excluded.author, scope = excluded.scope, topics = excluded.topics,
            applies_to = excluded.applies_to, packages = excluded.packages,
            evidence = excluded.evidence, supersedes = excluded.supersedes, tags = excluded.tags,
            created_at = excluded.created_at, updated_at = excluded.updated_at,
            updated_by = excluded.updated_by, version = excluded.version
          RETURNING ${columns(tx)}`
        if (!stored) throw new Error('knowledge upsert returned nothing')
        return toKnowledgeEntry(stored)
      })
    },
    async get(id) {
      const { sql, t } = await db()
      const [row]: KnowledgeRow[] = await sql`
        SELECT ${columns(sql)} FROM ${t.knowledge} k WHERE k.id = ${id}`
      return row ? toKnowledgeEntry(row) : undefined
    },
    async history(id) {
      const { sql, t } = await db()
      const rows: KnowledgeHistoryRow[] = await sql`
        SELECT version, content, edited_by, edited_at FROM ${t.knowledgeHistory}
        WHERE entry_id = ${id} ORDER BY version DESC`
      return rows.map(toKnowledgeRevision)
    },
    async list(filter) {
      const { sql, t } = await db()
      const rows: KnowledgeRow[] = await sql`
        SELECT ${columns(sql)} FROM ${t.knowledge} k WHERE ${where(sql, filter)}
        ORDER BY k.updated_at DESC, k.seq DESC`
      return rows.map(toKnowledgeEntry)
    },
    async remove(id) {
      const { sql, t } = await db()
      await sql`DELETE FROM ${t.knowledge} WHERE id = ${id}`
    },
    async search(text, filter, limit = 20) {
      const terms = searchTerms(text)
      if (!terms.length) return []
      const { sql, t } = await db()
      const rows: (KnowledgeRow & { score: number })[] = await sql`
        WITH q AS (
          SELECT to_tsquery('simple', string_agg(
            '''' || replace(replace(${t.knowledgeFold}(term), '\\', '\\\\'), '''', '''''') || ''':*',
            ' | ')) AS query
          FROM jsonb_array_elements_text(${sql.json(terms)}::jsonb) AS term
        )
        SELECT ${columns(sql)},
          ts_rank(${sql.array([...RANK_WEIGHTS], 'FLOAT4')}, k.search, q.query) AS score
        FROM ${t.knowledge} k, q
        WHERE k.search @@ q.query AND ${where(sql, filter)}
        ORDER BY score DESC, k.updated_at DESC, k.seq DESC
        LIMIT ${limit}`
      return rows.map(({ score, ...row }) => ({ entry: toKnowledgeEntry(row), score }))
    },
  }
}
