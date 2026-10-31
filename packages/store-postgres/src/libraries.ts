import type {
  LibraryChunk,
  LibraryChunkFilter,
  LibraryEcosystem,
  LibraryIssue,
  LibraryRecord,
  LibraryStore,
  LibraryVersionRecord,
} from '@holtkeeper/store'
import {
  compareLibraryVersions,
  libraryIssueBodyText,
  libraryIssueDigestText,
  libraryQueryTerms,
  newestVersionsFirst,
  plainChunk,
} from '@holtkeeper/store'
import type { SQL } from 'bun'

import { RANK_WEIGHTS } from './knowledge.ts'
import type { Db } from './tables.ts'

interface ChunkRow {
  id: string
  ecosystem: LibraryEcosystem
  name: string
  source: LibraryChunk['source']
  path: string
  headings: string[]
  anchor: string | null
  text: string
  url: string | null
  versions: string[]
}

/**
 * The `tsquery` text of a library search, before accent folding: words become prefix operands
 * (`'migr':*`), quoted phrases of several words phrase operands (`('cannot' <-> 'read')`),
 * OR-ed. Words hold only letters, digits and `_`, so nothing in the input reaches the parser
 * as syntax. `undefined` for text without words.
 */
export function libraryTsQuery(text: string): string | undefined {
  const terms = libraryQueryTerms(text)
  if (!terms.length) return undefined
  return terms
    .map((term) =>
      term.length === 1 ? `'${term[0]}':*` : `(${term.map((word) => `'${word}'`).join(' <-> ')})`,
    )
    .join(' | ')
}

const toChunk = (r: ChunkRow): LibraryChunk => ({
  ecosystem: r.ecosystem,
  name: r.name,
  id: r.id,
  versions: newestVersionsFirst(r.versions),
  source: r.source,
  path: r.path,
  headings: r.headings,
  ...(r.anchor !== null && { anchor: r.anchor }),
  text: r.text,
  ...(r.url !== null && { url: r.url }),
})

const chunkColumns = (sql: SQL, t: Db['t']) => sql`c.id, c.ecosystem, c.name, c.source, c.path,
  c.headings, c.anchor, c.text, c.url,
  COALESCE((SELECT jsonb_agg(cv.version) FROM ${t.libraryChunkVersions} cv WHERE cv.chunk_id = c.id),
    '[]'::jsonb) AS versions`

function chunkWhere(sql: SQL, t: Db['t'], filter: LibraryChunkFilter = {}) {
  const ecosystem = filter.ecosystem ?? null
  const name = filter.name ?? null
  const version = filter.version ?? null
  const source = filter.source ?? null
  const path = filter.path ?? null
  return sql`
    (${ecosystem}::text IS NULL OR c.ecosystem = ${ecosystem}::text)
    AND (${name}::text IS NULL OR c.name = ${name}::text)
    AND (${version}::text IS NULL OR EXISTS (
      SELECT 1 FROM ${t.libraryChunkVersions} cv
      WHERE cv.chunk_id = c.id AND cv.version = ${version}::text))
    AND (${source}::text IS NULL OR c.source = ${source}::text)
    AND (${path}::text IS NULL OR c.path = ${path}::text)`
}

const chunkOrder = (sql: SQL) =>
  sql`c.path COLLATE "C", c.position, c.ecosystem COLLATE "C", c.name COLLATE "C", c.id COLLATE "C"`

const query = (t: Db['t'], sql: SQL, text: string) =>
  sql`to_tsquery('simple', ${t.knowledgeFold}(${text}::text))`

/**
 * The SQL `LibraryStore`: records as `jsonb` in `libraries` and `library_versions`, chunks in
 * `library_chunks` with their versions in `library_chunk_versions`, issues in `library_issues`,
 * each searched through a generated `tsvector`.
 */
export function postgresLibraries(db: () => Promise<Db>): LibraryStore {
  return {
    async libraryStats({ ecosystem } = {}) {
      const { sql, t } = await db()
      const rows: {
        ecosystem: string
        name: string
        versions: number
        chunks: number
        issues: number
      }[] = await sql`
        SELECT l.ecosystem, l.name,
          (SELECT count(*)::int FROM ${t.libraryVersions} v
            WHERE v.ecosystem = l.ecosystem AND v.name = l.name) AS versions,
          (SELECT count(*)::int FROM ${t.libraryChunks} c
            WHERE c.ecosystem = l.ecosystem AND c.name = l.name) AS chunks,
          (SELECT count(*)::int FROM ${t.libraryIssues} i
            WHERE i.ecosystem = l.ecosystem AND i.name = l.name) AS issues
        FROM ${t.libraries} l
        WHERE (${ecosystem ?? null}::text IS NULL OR l.ecosystem = ${ecosystem ?? null}::text)`
      return new Map(
        rows.map((row) => [
          `${row.ecosystem}:${row.name}`,
          { versions: row.versions, chunks: row.chunks, issues: row.issues },
        ]),
      )
    },
    async putLibrary(record) {
      const { sql, t } = await db()
      await sql`
        INSERT INTO ${t.libraries} (ecosystem, name, data)
        VALUES (${record.ecosystem}, ${record.name}, ${sql.json(record)})
        ON CONFLICT (ecosystem, name) DO UPDATE SET data = EXCLUDED.data`
    },
    async getLibrary(ref) {
      const { sql, t } = await db()
      const [row]: { data: LibraryRecord }[] = await sql`
        SELECT data FROM ${t.libraries} WHERE ecosystem = ${ref.ecosystem} AND name = ${ref.name}`
      return row?.data
    },
    async listLibraries({ ecosystem, query: text } = {}) {
      const { sql, t } = await db()
      const rows: { data: LibraryRecord }[] = await sql`
        SELECT data FROM ${t.libraries}
        WHERE (${ecosystem ?? null}::text IS NULL OR ecosystem = ${ecosystem ?? null}::text)
          AND (${text ?? null}::text IS NULL OR strpos(lower(name), lower(${text ?? null}::text)) > 0)
        ORDER BY ecosystem COLLATE "C", name COLLATE "C"`
      return rows.map((row) => row.data)
    },
    async removeLibrary(ref) {
      const { sql, t } = await db()
      await sql.begin(async (tx) => {
        await tx`DELETE FROM ${t.libraries} WHERE ecosystem = ${ref.ecosystem} AND name = ${ref.name}`
        await tx`DELETE FROM ${t.libraryVersions} WHERE ecosystem = ${ref.ecosystem} AND name = ${ref.name}`
        await tx`DELETE FROM ${t.libraryChunks} WHERE ecosystem = ${ref.ecosystem} AND name = ${ref.name}`
        await tx`DELETE FROM ${t.libraryIssues} WHERE ecosystem = ${ref.ecosystem} AND name = ${ref.name}`
      })
    },

    async putVersion(record) {
      const { sql, t } = await db()
      await sql`
        INSERT INTO ${t.libraryVersions} (ecosystem, name, version, data)
        VALUES (${record.ecosystem}, ${record.name}, ${record.version}, ${sql.json(record)})
        ON CONFLICT (ecosystem, name, version) DO UPDATE SET data = EXCLUDED.data`
    },
    async getVersion(ref, version) {
      const { sql, t } = await db()
      const [row]: { data: LibraryVersionRecord }[] = await sql`
        SELECT data FROM ${t.libraryVersions}
        WHERE ecosystem = ${ref.ecosystem} AND name = ${ref.name} AND version = ${version}`
      return row?.data
    },
    async listVersions(ref) {
      const { sql, t } = await db()
      const rows: { data: LibraryVersionRecord }[] = await sql`
        SELECT data FROM ${t.libraryVersions} WHERE ecosystem = ${ref.ecosystem} AND name = ${ref.name}`
      return rows
        .map((row) => row.data)
        .toSorted((a, b) => compareLibraryVersions(b.version, a.version))
    },
    async removeVersion(ref, version) {
      const { sql, t } = await db()
      await sql.begin(async (tx) => {
        await tx`
          DELETE FROM ${t.libraryVersions}
          WHERE ecosystem = ${ref.ecosystem} AND name = ${ref.name} AND version = ${version}`
        await tx`
          DELETE FROM ${t.libraryChunkVersions} cv USING ${t.libraryChunks} c
          WHERE cv.chunk_id = c.id AND cv.version = ${version}
            AND c.ecosystem = ${ref.ecosystem} AND c.name = ${ref.name}`
        await tx`
          DELETE FROM ${t.libraryChunks} c
          WHERE c.ecosystem = ${ref.ecosystem} AND c.name = ${ref.name}
            AND NOT EXISTS (SELECT 1 FROM ${t.libraryChunkVersions} cv WHERE cv.chunk_id = c.id)`
      })
    },

    async replaceChunks(ref, version, source, chunks) {
      const seen = new Set<string>()
      const rows = chunks.flatMap((input, position) => {
        if (seen.has(input.id)) return []
        seen.add(input.id)
        const chunk = plainChunk(input)
        return [
          {
            id: chunk.id,
            path: chunk.path,
            position,
            headings: chunk.headings,
            heading_text: chunk.headings.join('\n'),
            anchor: chunk.anchor ?? null,
            text: chunk.text,
            url: chunk.url ?? null,
          },
        ]
      })
      const { sql, t } = await db()
      await sql.begin(async (tx) => {
        if (rows.length) {
          await tx`
            INSERT INTO ${t.libraryChunks} AS c
              (id, ecosystem, name, source, path, position, headings, heading_text, anchor, text, url)
            SELECT x.id, ${ref.ecosystem}, ${ref.name}, ${source}, x.path, x.position, x.headings,
              x.heading_text, x.anchor, x.text, x.url
            FROM jsonb_to_recordset(${tx.json(rows)}::jsonb) AS x (id text, path text, position integer,
              headings jsonb, heading_text text, anchor text, text text, url text)
            ON CONFLICT (id) DO UPDATE SET ecosystem = EXCLUDED.ecosystem, name = EXCLUDED.name,
              source = EXCLUDED.source, path = EXCLUDED.path, position = EXCLUDED.position,
              headings = EXCLUDED.headings, heading_text = EXCLUDED.heading_text,
              anchor = EXCLUDED.anchor, text = EXCLUDED.text, url = EXCLUDED.url`
          await tx`
            INSERT INTO ${t.libraryChunkVersions} (chunk_id, version)
            SELECT id, ${version} FROM jsonb_array_elements_text(${tx.json([...seen])}::jsonb) AS ids (id)
            ON CONFLICT DO NOTHING`
        }
        await tx`
          DELETE FROM ${t.libraryChunkVersions} cv USING ${t.libraryChunks} c
          WHERE cv.chunk_id = c.id AND cv.version = ${version}
            AND c.ecosystem = ${ref.ecosystem} AND c.name = ${ref.name} AND c.source = ${source}
            AND NOT (c.id IN (SELECT jsonb_array_elements_text(${tx.json([...seen])}::jsonb)))`
        await tx`
          DELETE FROM ${t.libraryChunks} c
          WHERE c.ecosystem = ${ref.ecosystem} AND c.name = ${ref.name}
            AND NOT EXISTS (SELECT 1 FROM ${t.libraryChunkVersions} cv WHERE cv.chunk_id = c.id)`
      })
    },
    async listChunks(filter, limit = 200) {
      const { sql, t } = await db()
      const rows: ChunkRow[] = await sql`
        SELECT ${chunkColumns(sql, t)} FROM ${t.libraryChunks} c
        WHERE ${chunkWhere(sql, t, filter)}
        ORDER BY ${chunkOrder(sql)} LIMIT ${limit}`
      return rows.map(toChunk)
    },
    async searchChunks(text, filter, limit = 20) {
      const tsquery = libraryTsQuery(text)
      if (!tsquery) return []
      const { sql, t } = await db()
      const rows: (ChunkRow & { score: number })[] = await sql`
        WITH q AS (SELECT ${query(t, sql, tsquery)} AS query)
        SELECT ${chunkColumns(sql, t)},
          ts_rank(${sql.array([...RANK_WEIGHTS], 'FLOAT4')}, c.search, q.query) AS score
        FROM ${t.libraryChunks} c, q
        WHERE c.search @@ q.query AND ${chunkWhere(sql, t, filter)}
        ORDER BY score DESC, ${chunkOrder(sql)} LIMIT ${limit}`
      return rows.map(({ score, ...row }) => ({ chunk: toChunk(row), score }))
    },

    async putIssues(issues) {
      if (!issues.length) return
      const latest = new Map(issues.map((issue) => [issue.id, issue]))
      const rows = [...latest.values()].map((issue) => ({
        id: issue.id,
        ecosystem: issue.ecosystem,
        name: issue.name,
        state: issue.state,
        updated_at: issue.updatedAt,
        title: issue.title,
        digest_text: libraryIssueDigestText(issue),
        body_text: libraryIssueBodyText(issue),
        data: issue,
      }))
      const { sql, t } = await db()
      await sql`
        INSERT INTO ${t.libraryIssues}
          (id, ecosystem, name, state, updated_at, title, digest_text, body_text, data)
        SELECT x.id, x.ecosystem, x.name, x.state, x.updated_at, x.title, x.digest_text,
          x.body_text, x.data
        FROM jsonb_to_recordset(${sql.json(rows)}::jsonb) AS x (id text, ecosystem text, name text,
          state text, updated_at text, title text, digest_text text, body_text text, data jsonb)
        ON CONFLICT (id) DO UPDATE SET ecosystem = EXCLUDED.ecosystem, name = EXCLUDED.name,
          state = EXCLUDED.state, updated_at = EXCLUDED.updated_at, title = EXCLUDED.title,
          digest_text = EXCLUDED.digest_text, body_text = EXCLUDED.body_text, data = EXCLUDED.data`
    },
    async getIssue(id) {
      const { sql, t } = await db()
      const [row]: { data: LibraryIssue }[] = await sql`
        SELECT data FROM ${t.libraryIssues} WHERE id = ${id}`
      return row?.data
    },
    async searchIssues(text, filter = {}, limit = 20) {
      const tsquery = libraryTsQuery(text)
      if (!tsquery) return []
      const { sql, t } = await db()
      const ecosystem = filter.ecosystem ?? null
      const name = filter.name ?? null
      const state = filter.state ?? null
      const rows: { data: LibraryIssue; score: number }[] = await sql`
        WITH q AS (SELECT ${query(t, sql, tsquery)} AS query)
        SELECT i.data, ts_rank(${sql.array([...RANK_WEIGHTS], 'FLOAT4')}, i.search, q.query) AS score
        FROM ${t.libraryIssues} i, q
        WHERE i.search @@ q.query
          AND (${ecosystem}::text IS NULL OR i.ecosystem = ${ecosystem}::text)
          AND (${name}::text IS NULL OR i.name = ${name}::text)
          AND (${state}::text IS NULL OR i.state = ${state}::text)
        ORDER BY score DESC, i.updated_at COLLATE "C" DESC, i.id COLLATE "C" LIMIT ${limit}`
      return rows.map((row) => ({ issue: row.data, score: row.score }))
    },
  }
}
