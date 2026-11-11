import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { sqliteConfig } from './config.ts'
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

  test('v22 removes what retired analyzers and settings left behind', async () => {
    const db = new Database(':memory:')
    migrate(
      db,
      migrations.filter((m) => m.version <= 21),
    )
    const at = '2026-11-01T00:00:00.000Z'
    for (const [id, kind] of [
      ['a1', 'quality'],
      ['a2', 'release-risk'],
      ['a3', 'depgraph'],
    ] as const)
      db.run(
        `INSERT INTO analyses (id, repo_forge, repo_path, kind, created_at, data)
         VALUES (?, 'work', 'shapes/a', ?, ?, '{}')`,
        [id, kind, at],
      )
    for (const [id, analyzer] of [
      ['j1', 'warmup'],
      ['j2', 'bundle'],
    ] as const)
      db.run(
        `INSERT INTO jobs (id, analyzer, repo_forge, repo_path, options, trigger, status,
           attempts, max_attempts, run_after, created_at)
         VALUES (?, ?, 'work', 'shapes/a', '{}', 'manual', 'queued', 0, 3, ?, ?)`,
        [id, analyzer, at, at],
      )
    for (const [id, key] of [
      ['s1', 'analyzers.port'],
      ['s2', 'llm.models'],
      ['s3', 'analyzers.bundle'],
    ] as const)
      db.run(
        `INSERT INTO settings (id, key, scope, value, secret, updated_at)
         VALUES (?, ?, '{"all":true}', '{}', 0, ?)`,
        [id, key, at],
      )
    for (const key of ['digests', 'digest:run:d1', 'chat:slack:policy', 'chat:slack:connection'])
      db.run('INSERT INTO kv (key, value) VALUES (?, ?)', [key, '{}'])
    const config = sqliteConfig(db)
    const doc = (type: 'schedule' | 'trigger', id: string, data: unknown) =>
      config.put({ type, id, data, updatedAt: at, updatedBy: 'person' } as never)
    await doc('schedule', 'mixed', {
      name: 'Mixed',
      enabled: true,
      analyzers: ['changelog', 'bundle', 'release-risk', 'coverage'],
      options: { 'release-risk': { x: 1 }, bundle: { y: 2 } },
    })
    await doc('schedule', 'gone', { name: 'Gone', enabled: true, analyzers: ['fleet', 'delivery'] })
    await doc('schedule', 'kept', { name: 'Kept', enabled: true, analyzers: ['bundle'] })
    await doc('trigger', 'tag', { on: 'tag', analyzers: ['changelog', 'api-surface'] })
    await doc('trigger', 'cmd', { on: 'command', command: 'port', analyzer: 'port' })
    await doc('trigger', 'new-repo', { on: 'newRepo' })

    migrate(db)
    expect(versions(db)).toContain(22)
    const ids = (sql: string) =>
      db
        .query<{ id: string }, []>(sql)
        .all()
        .map((row) => row.id)
    expect(ids('SELECT id FROM analyses')).toEqual(['a3'])
    expect(ids('SELECT id FROM jobs')).toEqual(['j2'])
    expect(ids('SELECT id FROM settings')).toEqual(['s3'])
    expect(ids('SELECT key AS id FROM kv ORDER BY key')).toEqual(['chat:slack:connection'])

    expect(await config.get('schedule', 'gone')).toBeUndefined()
    expect(await config.history('schedule', 'gone')).toEqual([])
    expect(await config.get('trigger', 'cmd')).toBeUndefined()
    const mixed = await config.get('schedule', 'mixed')
    expect(mixed).toMatchObject({
      version: 2,
      updatedBy: 'system',
      data: { analyzers: ['bundle', 'coverage'], options: { bundle: { y: 2 } } },
    })
    expect((await config.history('schedule', 'mixed')).map((revision) => revision.version)).toEqual(
      [1],
    )
    expect((await config.get('trigger', 'tag'))?.data).toEqual({
      on: 'tag',
      analyzers: ['api-surface'],
    })
    expect(await config.get('schedule', 'kept')).toMatchObject({ version: 1, updatedBy: 'person' })
    expect(await config.get('trigger', 'new-repo')).toMatchObject({
      version: 1,
      data: { on: 'newRepo' },
    })
    db.close()
  })
})
