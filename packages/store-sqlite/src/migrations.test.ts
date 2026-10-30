import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { type Migration, migrate, migrations } from './migrations.ts'

const versions = (db: Database) =>
  db
    .query<{ version: number }, []>('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((row) => row.version)

describe('migrate', () => {
  test('applies a lower version added after a higher one was recorded', () => {
    const db = new Database(':memory:')
    const one: Migration = { version: 1, sql: 'CREATE TABLE a (x TEXT)' }
    const three: Migration = { version: 3, sql: 'CREATE TABLE c (x TEXT)' }
    const two: Migration = { version: 2, sql: 'CREATE TABLE b (x TEXT)' }
    migrate(db, [one, three])
    migrate(db, [one, two, three])
    migrate(db, [one, two, three])
    expect(versions(db)).toEqual([1, 2, 3])
    expect(db.query('SELECT * FROM b').all()).toEqual([])
    db.close()
  })

  test('v5 adds credential options to a v4 database', () => {
    const db = new Database(':memory:')
    migrate(
      db,
      migrations.filter((m) => m.version <= 4),
    )
    db.run(
      `INSERT INTO credentials (id, name, kind, url, scope, secret, created_at, updated_at)
       VALUES ('c1', 'n', 'gitlab', 'u', '{}', 's', 'now', 'now')`,
    )
    migrate(db)
    expect(versions(db)).toContain(5)
    const row = db
      .query<{ options: string | null }, []>("SELECT options FROM credentials WHERE id = 'c1'")
      .get()
    expect(row?.options).toBeNull()
    db.close()
  })

  test('v7 adds config documents, their history and kv to a v6 database', () => {
    const db = new Database(':memory:')
    migrate(
      db,
      migrations.filter((m) => m.version <= 6),
    )
    migrate(db)
    expect(versions(db)).toContain(7)
    for (const table of ['config_documents', 'config_history', 'kv'])
      expect(db.query(`SELECT * FROM ${table}`).all()).toEqual([])
    db.close()
  })
})
