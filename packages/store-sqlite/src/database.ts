import type { Database } from 'bun:sqlite'

import type { DatabaseIndex, DatabaseInspector, DatabaseTable } from '@holtkeeper/store'

const pragma = (db: Database, name: 'page_size' | 'page_count' | 'freelist_count') =>
  db.query<Record<string, number>, []>(`PRAGMA ${name}`).get()?.[name] ?? 0

/** Bytes per table or index from the `dbstat` virtual table; empty when SQLite lacks it. */
function pageSizes(db: Database): Map<string, number> {
  try {
    const rows = db
      .query<{ name: string; bytes: number }, []>(
        'SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name',
      )
      .all()
    return new Map(rows.map((row) => [row.name, row.bytes]))
  } catch {
    return new Map()
  }
}

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`

/**
 * Introspection of a SQLite store: sizes from `dbstat`, exact row counts, no statement or
 * session statistics (one process owns the file).
 */
export function sqliteDatabase(db: Database): DatabaseInspector {
  const objects = () =>
    db
      .query<{ type: string; name: string; tbl_name: string; sql: string | null }, []>(
        `SELECT type, name, tbl_name, sql FROM sqlite_master
         WHERE type = 'index' OR (type = 'table' AND name NOT LIKE 'sqlite!_%' ESCAPE '!')`,
      )
      .all()

  return {
    engine: 'sqlite',
    async overview() {
      const pageSize = pragma(db, 'page_size')
      const { version } = db
        .query<{ version: string }, []>('SELECT sqlite_version() AS version')
        .get()!
      return {
        engine: 'sqlite',
        version: `SQLite ${version}`,
        bytes: pragma(db, 'page_count') * pageSize,
        freeBytes: pragma(db, 'freelist_count') * pageSize,
      }
    },
    async tables() {
      const sizes = pageSizes(db)
      const all = objects()
      const tables: DatabaseTable[] = all
        .filter((entry) => entry.type === 'table')
        .map((entry) => {
          const dataBytes = sizes.get(entry.name) ?? 0
          const indexBytes = all
            .filter((index) => index.type === 'index' && index.tbl_name === entry.name)
            .reduce((sum, index) => sum + (sizes.get(index.name) ?? 0), 0)
          const { rows } = db
            .query<{ rows: number }, []>(`SELECT COUNT(*) AS rows FROM ${quoted(entry.name)}`)
            .get()!
          return {
            name: entry.name,
            rows,
            dataBytes,
            indexBytes,
            toastBytes: 0,
            totalBytes: dataBytes + indexBytes,
          }
        })
      return tables.toSorted((a, b) => b.totalBytes - a.totalBytes || a.name.localeCompare(b.name))
    },
    async indexes() {
      const sizes = pageSizes(db)
      const indexes: DatabaseIndex[] = objects()
        .filter((entry) => entry.type === 'index')
        .map((entry) => ({
          name: entry.name,
          table: entry.tbl_name,
          bytes: sizes.get(entry.name) ?? 0,
          definition: entry.sql ?? `UNIQUE or PRIMARY KEY constraint of ${entry.tbl_name}`,
          unique: entry.sql === null || /^CREATE UNIQUE/i.test(entry.sql),
          primary: false,
        }))
      return indexes.toSorted((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
    },
    async queries() {
      return { available: false, reason: 'SQLite keeps no statement statistics' }
    },
    async sessions() {
      return []
    },
    async migrations() {
      return db
        .query<{ version: number; appliedAt: string }, []>(
          'SELECT version, applied_at AS appliedAt FROM schema_migrations ORDER BY version',
        )
        .all()
    },
  }
}
