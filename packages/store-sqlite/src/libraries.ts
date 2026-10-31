import type { Database } from 'bun:sqlite'

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

interface ChunkRow {
  id: string
  ecosystem: LibraryEcosystem
  name: string
  source: LibraryChunk['source']
  path: string
  headings: string
  anchor: string | null
  text: string
  url: string | null
  versions: string
}

type ChunkFilterParams = [string | null, string | null, string | null, string | null, string | null]

type IssueFilterParams = [string | null, string | null, string | null]

/**
 * Turns free text into an FTS5 query that cannot fail to parse: words become quoted prefix
 * terms (`"migr"*`), quoted phrases of several words quoted phrases (`"cannot read"`), OR-ed.
 */
export function libraryFtsQuery(text: string): string | undefined {
  const terms = libraryQueryTerms(text)
  if (!terms.length) return undefined
  return terms
    .map((term) => (term.length === 1 ? `"${term[0]}"*` : `"${term.join(' ')}"`))
    .join(' OR ')
}

const toChunk = (r: ChunkRow): LibraryChunk => ({
  ecosystem: r.ecosystem,
  name: r.name,
  id: r.id,
  versions: newestVersionsFirst(versionList(r.versions)),
  source: r.source,
  path: r.path,
  headings: JSON.parse(r.headings),
  ...(r.anchor !== null && { anchor: r.anchor }),
  text: r.text,
  ...(r.url !== null && { url: r.url }),
})

const chunkParams = (filter: LibraryChunkFilter = {}): ChunkFilterParams => [
  filter.ecosystem ?? null,
  filter.name ?? null,
  filter.version ?? null,
  filter.source ?? null,
  filter.path ?? null,
]

const chunkColumns = `c.id, c.ecosystem, c.name, c.source, c.path, c.headings, c.anchor, c.text, c.url,
  (SELECT json_group_array(version) FROM library_chunk_versions WHERE chunk_id = c.id) AS versions`

const chunkWhere = `
  (?1 IS NULL OR c.ecosystem = ?1)
  AND (?2 IS NULL OR c.name = ?2)
  AND (?3 IS NULL OR EXISTS (
    SELECT 1 FROM library_chunk_versions cv WHERE cv.chunk_id = c.id AND cv.version = ?3))
  AND (?4 IS NULL OR c.source = ?4)
  AND (?5 IS NULL OR c.path = ?5)`

const chunkOrder = 'c.path, c.position, c.ecosystem, c.name, c.id'

const versionList = (json: string): string[] => {
  const value: unknown = JSON.parse(json)
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

const libraryOf = (data: string): LibraryRecord => JSON.parse(data)
const versionOf = (data: string): LibraryVersionRecord => JSON.parse(data)
const issueOf = (data: string): LibraryIssue => JSON.parse(data)

const issueWhere = `
  (?1 IS NULL OR i.ecosystem = ?1)
  AND (?2 IS NULL OR i.name = ?2)
  AND (?3 IS NULL OR i.state = ?3)`

/**
 * The SQLite `LibraryStore`: records as JSON in `libraries` and `library_versions`, chunks in
 * `library_chunks` with their versions in `library_chunk_versions`, issues in `library_issues`,
 * FTS5 search over both.
 */
export function sqliteLibraries(db: Database): LibraryStore {
  const sql = {
    putLibrary: db.prepare(
      `INSERT INTO libraries (ecosystem, name, data) VALUES (?, ?, ?)
       ON CONFLICT (ecosystem, name) DO UPDATE SET data = excluded.data`,
    ),
    getLibrary: db.query<{ data: string }, [string, string]>(
      'SELECT data FROM libraries WHERE ecosystem = ? AND name = ?',
    ),
    libraryStats: db.query<
      { ecosystem: string; name: string; versions: number; chunks: number; issues: number },
      [string | null]
    >(
      `SELECT l.ecosystem, l.name,
         (SELECT count(*) FROM library_versions v WHERE v.ecosystem = l.ecosystem AND v.name = l.name) AS versions,
         (SELECT count(*) FROM library_chunks c WHERE c.ecosystem = l.ecosystem AND c.name = l.name) AS chunks,
         (SELECT count(*) FROM library_issues i WHERE i.ecosystem = l.ecosystem AND i.name = l.name) AS issues
       FROM libraries l WHERE (?1 IS NULL OR l.ecosystem = ?1)`,
    ),
    listLibraries: db.query<{ data: string }, [string | null, string | null]>(
      `SELECT data FROM libraries
       WHERE (?1 IS NULL OR ecosystem = ?1) AND (?2 IS NULL OR instr(lower(name), lower(?2)) > 0)
       ORDER BY ecosystem, name`,
    ),
    removeLibrary: [
      'DELETE FROM libraries WHERE ecosystem = ? AND name = ?',
      'DELETE FROM library_versions WHERE ecosystem = ? AND name = ?',
      'DELETE FROM library_chunks WHERE ecosystem = ? AND name = ?',
      'DELETE FROM library_issues WHERE ecosystem = ? AND name = ?',
    ].map((statement) => db.prepare(statement)),
    putVersion: db.prepare(
      `INSERT INTO library_versions (ecosystem, name, version, data) VALUES (?, ?, ?, ?)
       ON CONFLICT (ecosystem, name, version) DO UPDATE SET data = excluded.data`,
    ),
    getVersion: db.query<{ data: string }, [string, string, string]>(
      'SELECT data FROM library_versions WHERE ecosystem = ? AND name = ? AND version = ?',
    ),
    listVersions: db.query<{ data: string; version: string }, [string, string]>(
      'SELECT version, data FROM library_versions WHERE ecosystem = ? AND name = ?',
    ),
    removeVersionRow: db.prepare(
      'DELETE FROM library_versions WHERE ecosystem = ? AND name = ? AND version = ?',
    ),
    dropVersionFromChunks: db.prepare(
      `DELETE FROM library_chunk_versions WHERE version = ?3 AND chunk_id IN (
         SELECT id FROM library_chunks WHERE ecosystem = ?1 AND name = ?2)`,
    ),
    dropVersionFromOtherChunks: db.prepare(
      `DELETE FROM library_chunk_versions WHERE version = ?3
         AND chunk_id IN (SELECT id FROM library_chunks WHERE ecosystem = ?1 AND name = ?2 AND source = ?4)
         AND chunk_id NOT IN (SELECT value FROM json_each(?5))`,
    ),
    dropOrphans: db.prepare(
      `DELETE FROM library_chunks WHERE ecosystem = ? AND name = ? AND NOT EXISTS (
         SELECT 1 FROM library_chunk_versions cv WHERE cv.chunk_id = library_chunks.id)`,
    ),
    upsertChunk: db.prepare(
      `INSERT INTO library_chunks (id, ecosystem, name, source, path, position, headings, heading_text, anchor, text, url)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT (id) DO UPDATE SET ecosystem = excluded.ecosystem, name = excluded.name,
         source = excluded.source, path = excluded.path, position = excluded.position,
         headings = excluded.headings, heading_text = excluded.heading_text, anchor = excluded.anchor,
         text = excluded.text, url = excluded.url`,
    ),
    addChunkVersion: db.prepare(
      'INSERT OR IGNORE INTO library_chunk_versions (chunk_id, version) VALUES (?, ?)',
    ),
    listChunks: db.query<ChunkRow, [...ChunkFilterParams, number]>(
      `SELECT ${chunkColumns} FROM library_chunks c WHERE ${chunkWhere} ORDER BY ${chunkOrder} LIMIT ?6`,
    ),
    searchChunks: db.query<ChunkRow & { rank: number }, [...ChunkFilterParams, string, number]>(
      `SELECT ${chunkColumns}, bm25(library_chunks_fts, 3.0, 1.0) AS rank
       FROM library_chunks_fts JOIN library_chunks c ON c.seq = library_chunks_fts.rowid
       WHERE library_chunks_fts MATCH ?6 AND ${chunkWhere}
       ORDER BY rank, ${chunkOrder} LIMIT ?7`,
    ),
    putIssue: db.prepare(
      `INSERT INTO library_issues (id, ecosystem, name, state, updated_at, title, digest_text, body_text, data)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT (id) DO UPDATE SET ecosystem = excluded.ecosystem, name = excluded.name,
         state = excluded.state, updated_at = excluded.updated_at, title = excluded.title,
         digest_text = excluded.digest_text, body_text = excluded.body_text, data = excluded.data`,
    ),
    getIssue: db.query<{ data: string }, [string]>('SELECT data FROM library_issues WHERE id = ?'),
    searchIssues: db.query<{ data: string; rank: number }, [...IssueFilterParams, string, number]>(
      `SELECT i.data, bm25(library_issues_fts, 5.0, 3.0, 1.0) AS rank
       FROM library_issues_fts JOIN library_issues i ON i.seq = library_issues_fts.rowid
       WHERE library_issues_fts MATCH ?4 AND ${issueWhere}
       ORDER BY rank, i.updated_at DESC, i.id LIMIT ?5`,
    ),
  }

  const removeLibrary = db.transaction((ecosystem: string, name: string) => {
    for (const statement of sql.removeLibrary) statement.run(ecosystem, name)
  })

  const removeVersion = db.transaction((ecosystem: string, name: string, version: string) => {
    sql.removeVersionRow.run(ecosystem, name, version)
    sql.dropVersionFromChunks.run(ecosystem, name, version)
    sql.dropOrphans.run(ecosystem, name)
  })

  const replaceChunks = db.transaction(
    (
      ecosystem: LibraryEcosystem,
      name: string,
      version: string,
      source: LibraryChunk['source'],
      chunks: Omit<LibraryChunk, 'versions'>[],
    ) => {
      const ids = new Set<string>()
      chunks.forEach((input, position) => {
        if (ids.has(input.id)) return
        ids.add(input.id)
        const chunk = plainChunk(input)
        sql.upsertChunk.run(
          chunk.id,
          ecosystem,
          name,
          source,
          chunk.path,
          position,
          JSON.stringify(chunk.headings),
          chunk.headings.join('\n'),
          chunk.anchor ?? null,
          chunk.text,
          chunk.url ?? null,
        )
        sql.addChunkVersion.run(chunk.id, version)
      })
      sql.dropVersionFromOtherChunks.run(ecosystem, name, version, source, JSON.stringify([...ids]))
      sql.dropOrphans.run(ecosystem, name)
    },
  )

  const putIssues = db.transaction((issues: LibraryIssue[]) => {
    for (const issue of issues)
      sql.putIssue.run(
        issue.id,
        issue.ecosystem,
        issue.name,
        issue.state,
        issue.updatedAt,
        issue.title,
        libraryIssueDigestText(issue),
        libraryIssueBodyText(issue),
        JSON.stringify(issue),
      )
  })

  return {
    async putLibrary(record) {
      sql.putLibrary.run(record.ecosystem, record.name, JSON.stringify(record))
    },
    async getLibrary(ref) {
      const row = sql.getLibrary.get(ref.ecosystem, ref.name)
      return row ? libraryOf(row.data) : undefined
    },
    async listLibraries({ ecosystem, query } = {}) {
      return sql.listLibraries
        .all(ecosystem ?? null, query ?? null)
        .map((row) => libraryOf(row.data))
    },
    async removeLibrary(ref) {
      removeLibrary.immediate(ref.ecosystem, ref.name)
    },
    async putVersion(record) {
      sql.putVersion.run(record.ecosystem, record.name, record.version, JSON.stringify(record))
    },
    async getVersion(ref, version) {
      const row = sql.getVersion.get(ref.ecosystem, ref.name, version)
      return row ? versionOf(row.data) : undefined
    },
    async listVersions(ref) {
      return sql.listVersions
        .all(ref.ecosystem, ref.name)
        .toSorted((a, b) => compareLibraryVersions(b.version, a.version))
        .map((row) => versionOf(row.data))
    },
    async removeVersion(ref, version) {
      removeVersion.immediate(ref.ecosystem, ref.name, version)
    },
    async replaceChunks(ref, version, source, chunks) {
      replaceChunks.immediate(ref.ecosystem, ref.name, version, source, chunks)
    },
    async listChunks(filter, limit = 200) {
      return sql.listChunks.all(...chunkParams(filter), limit).map(toChunk)
    },
    async searchChunks(text, filter, limit = 20) {
      const query = libraryFtsQuery(text)
      if (!query) return []
      return sql.searchChunks
        .all(...chunkParams(filter), query, limit)
        .map((row) => ({ chunk: toChunk(row), score: -row.rank }))
    },
    async putIssues(issues) {
      if (issues.length) putIssues.immediate(issues)
    },
    async getIssue(id) {
      const row = sql.getIssue.get(id)
      return row ? issueOf(row.data) : undefined
    },
    async searchIssues(text, filter = {}, limit = 20) {
      const query = libraryFtsQuery(text)
      if (!query) return []
      return sql.searchIssues
        .all(filter.ecosystem ?? null, filter.name ?? null, filter.state ?? null, query, limit)
        .map((row) => ({ issue: issueOf(row.data), score: -row.rank }))
    },
    async libraryStats({ ecosystem } = {}) {
      return new Map(
        sql.libraryStats
          .all(ecosystem ?? null)
          .map((row) => [
            `${row.ecosystem}:${row.name}`,
            { versions: row.versions, chunks: row.chunks, issues: row.issues },
          ]),
      )
    },
  }
}
