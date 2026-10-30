import type { Database } from 'bun:sqlite'

import type {
  KnowledgeContent,
  KnowledgeEntry,
  KnowledgeEntryInput,
  KnowledgeFilter,
  KnowledgeRevision,
  KnowledgeStore,
} from '@holtkeeper/store'
import { knowledgeWords } from '@holtkeeper/store'

interface KnowledgeRow {
  id: string
  title: string
  body: string
  kind: KnowledgeEntry['kind']
  status: KnowledgeEntry['status']
  source: KnowledgeEntry['source']
  author: string
  scope: string
  topics: string
  applies_to: string
  packages: string | null
  evidence: string
  supersedes: string | null
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

type FilterParams = [
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
]

const toEntry = (r: KnowledgeRow): KnowledgeEntry => ({
  id: r.id,
  title: r.title,
  body: r.body,
  kind: r.kind,
  scope: JSON.parse(r.scope),
  topics: JSON.parse(r.topics),
  appliesTo: JSON.parse(r.applies_to),
  ...(r.packages !== null && { packages: JSON.parse(r.packages) }),
  status: r.status,
  evidence: JSON.parse(r.evidence),
  ...(r.supersedes !== null && { supersedes: r.supersedes }),
  source: r.source,
  author: r.author,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(r.updated_by !== null && { updatedBy: r.updated_by }),
  version: r.version,
})

const content = (entry: KnowledgeEntry): KnowledgeContent => ({
  title: entry.title,
  body: entry.body,
  kind: entry.kind,
  scope: entry.scope,
  topics: entry.topics,
  appliesTo: entry.appliesTo,
  ...(entry.packages !== undefined && { packages: entry.packages }),
  status: entry.status,
  evidence: entry.evidence,
  ...(entry.supersedes !== undefined && { supersedes: entry.supersedes }),
})

const listParam = <T>(value: T | T[] | undefined) =>
  value === undefined ? null : JSON.stringify([value].flat())

function filterParams(filter: KnowledgeFilter = {}): FilterParams {
  const pkg = filter.package
  const separator = pkg?.indexOf(':') ?? -1
  return [
    listParam(filter.status),
    listParam(filter.kind),
    filter.topic ?? null,
    filter.scope ?? null,
    pkg === undefined ? null : separator > 0 ? pkg.slice(separator + 1) : pkg,
    pkg !== undefined && separator > 0 ? pkg.slice(0, separator) : null,
  ]
}

const filterSql = `
  (?1 IS NULL OR k.status IN (SELECT value FROM json_each(?1)))
  AND (?2 IS NULL OR k.kind IN (SELECT value FROM json_each(?2)))
  AND (?3 IS NULL OR EXISTS (SELECT 1 FROM json_each(k.topics) WHERE lower(value) = lower(?3)))
  AND (?4 IS NULL
    OR (lower(?4) = 'all' AND json_extract(k.scope, '$.all') = 1)
    OR EXISTS (SELECT 1 FROM json_each(k.scope, '$.groups') WHERE instr(lower(value), lower(?4)) > 0)
    OR EXISTS (SELECT 1 FROM json_each(k.scope, '$.repos') WHERE instr(lower(value), lower(?4)) > 0))
  AND (?5 IS NULL OR EXISTS (
    SELECT 1 FROM json_each(k.packages)
    WHERE json_extract(value, '$.name') = ?5 AND (?6 IS NULL OR json_extract(value, '$.ecosystem') = ?6)))`

/**
 * Turns free text into an FTS5 query that cannot fail to parse: every word becomes a quoted
 * prefix term (`"migr"*`) and terms are OR-ed, so bm25 ranks entries matching more words higher.
 * Operators (`AND`, `NEAR`, `-`, `:`) and quotes in the input end up as plain words or are dropped.
 */
export function ftsQuery(text: string): string | undefined {
  const terms = [...new Set(knowledgeWords(text))]
  if (!terms.length) return undefined
  return terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(' OR ')
}

/** Topics and package names, indexed as their own FTS column. */
const tags = (entry: KnowledgeEntryInput) =>
  [...entry.topics, ...(entry.packages ?? []).map((pkg) => pkg.name)].join(' ')

/** The SQLite `KnowledgeStore`: rows in `knowledge`, versions in `knowledge_history`, FTS5 search. */
export function sqliteKnowledge(db: Database): KnowledgeStore {
  const sql = {
    get: db.query<KnowledgeRow, [string]>('SELECT * FROM knowledge WHERE id = ?'),
    upsert: db.query<
      KnowledgeRow,
      [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string | null,
        string,
        string | null,
        string,
        string,
        string,
        string | null,
        number,
      ]
    >(
      `INSERT INTO knowledge (id, title, body, kind, status, source, author, scope, topics, applies_to, packages,
         evidence, supersedes, tags, created_at, updated_at, updated_by, version)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
       ON CONFLICT (id) DO UPDATE SET title = excluded.title, body = excluded.body, kind = excluded.kind,
         status = excluded.status, source = excluded.source, author = excluded.author, scope = excluded.scope,
         topics = excluded.topics, applies_to = excluded.applies_to, packages = excluded.packages,
         evidence = excluded.evidence, supersedes = excluded.supersedes, tags = excluded.tags,
         created_at = excluded.created_at, updated_at = excluded.updated_at, updated_by = excluded.updated_by,
         version = excluded.version
       RETURNING *`,
    ),
    addRevision: db.prepare(
      `INSERT INTO knowledge_history (entry_id, version, content, edited_by, edited_at) VALUES (?, ?, ?, ?, ?)`,
    ),
    history: db.query<HistoryRow, [string]>(
      'SELECT * FROM knowledge_history WHERE entry_id = ? ORDER BY version DESC',
    ),
    list: db.query<KnowledgeRow, FilterParams>(
      `SELECT k.* FROM knowledge k WHERE ${filterSql} ORDER BY k.updated_at DESC, k.seq DESC`,
    ),
    search: db.query<KnowledgeRow & { rank: number }, [...FilterParams, string, number]>(
      `SELECT k.*, bm25(knowledge_fts, 5.0, 3.0, 1.0) AS rank
       FROM knowledge_fts JOIN knowledge k ON k.seq = knowledge_fts.rowid
       WHERE knowledge_fts MATCH ?7 AND ${filterSql}
       ORDER BY rank, k.seq DESC LIMIT ?8`,
    ),
    remove: db.prepare('DELETE FROM knowledge WHERE id = ?'),
  }

  const put = db.transaction((input: KnowledgeEntryInput): KnowledgeEntry => {
    const row = sql.get.get(input.id)
    const previous = row ? toEntry(row) : undefined
    if (previous) {
      sql.addRevision.run(
        previous.id,
        previous.version,
        JSON.stringify(content(previous)),
        previous.updatedBy ?? previous.author,
        previous.updatedAt,
      )
    }
    const stored = sql.upsert.get(
      input.id,
      input.title,
      input.body,
      input.kind,
      input.status,
      input.source,
      input.author,
      JSON.stringify(input.scope),
      JSON.stringify(input.topics),
      JSON.stringify(input.appliesTo),
      input.packages ? JSON.stringify(input.packages) : null,
      JSON.stringify(input.evidence),
      input.supersedes ?? null,
      tags(input),
      input.createdAt,
      input.updatedAt,
      input.updatedBy ?? null,
      (previous?.version ?? 0) + 1,
    )
    if (!stored) throw new Error('knowledge upsert returned nothing')
    return toEntry(stored)
  })

  return {
    async put(entry) {
      return put.immediate(entry)
    },
    async get(id) {
      const row = sql.get.get(id)
      return row ? toEntry(row) : undefined
    },
    async history(id) {
      return sql.history.all(id).map((r): KnowledgeRevision => ({
        ...JSON.parse(r.content),
        version: r.version,
        editedBy: r.edited_by,
        editedAt: r.edited_at,
      }))
    },
    async list(filter) {
      return sql.list.all(...filterParams(filter)).map(toEntry)
    },
    async remove(id) {
      sql.remove.run(id)
    },
    async search(text, filter, limit = 20) {
      const query = ftsQuery(text)
      if (!query) return []
      return sql.search
        .all(...filterParams(filter), query, limit)
        .map((row) => ({ entry: toEntry(row), score: -row.rank }))
    },
  }
}
