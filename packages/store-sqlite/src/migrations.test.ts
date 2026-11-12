import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sqliteConfig } from './config.ts'
import { type Migration, migrate, migrations } from './migrations.ts'
import { sqliteStore } from './sqlite.ts'

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

  test('v23 adds analysis metrics without touching existing records', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hk-sqlite-')), 'store.db')
    const db = new Database(path, { create: true })
    migrate(
      db,
      migrations.filter((m) => m.version <= 22),
    )
    db.run(
      `INSERT INTO analyses (id, repo_forge, repo_path, kind, created_at, data)
       VALUES ('a1', 'work', 'shapes/a', 'coverage', '2026-10-01T00:00:00.000Z', '{"n":1}')`,
    )
    db.close()
    const { analyses } = sqliteStore({ path })
    expect(await analyses.get('a1')).not.toHaveProperty('metrics')
    expect((await analyses.latestHeads())[0]).toMatchObject({ id: 'a1', kind: 'coverage' })
    const added = await analyses.add({
      repo: { forge: 'work', path: 'shapes/a' },
      kind: 'coverage',
      createdAt: '2026-10-02T00:00:00.000Z',
      data: { n: 2 },
      metrics: { percent: 50 },
    })
    expect((await analyses.latestHeads())[0]).toMatchObject({
      id: added.id,
      metrics: { percent: 50 },
    })
  })

  test('v24 adds ai usage origin and subject and indexes jobs by analysis', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hk-sqlite-')), 'store.db')
    const db = new Database(path, { create: true })
    migrate(
      db,
      migrations.filter((m) => m.version <= 23),
    )
    db.run(
      `INSERT INTO ai_usage (id, at, repo_forge, repo_path, groups, task_kind, actor, provider, model,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, cost_source,
         duration_ms, turns, outcome)
       VALUES ('u1', '2026-10-01T00:00:00.000Z', 'work', 'shapes/a', '[]', 'review', 'system',
         'anthropic', 'm', 1, 1, 0, 0, 0.5, 'reported', 10, 1, 'ok')`,
    )
    migrate(db)
    const indexes = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => row.name)
    expect(indexes).toEqual(
      expect.arrayContaining(['jobs_analysis', 'ai_usage_actor_at', 'ai_usage_job']),
    )
    db.close()
    const { aiUsage } = sqliteStore({ path })
    const [old] = await aiUsage.list()
    expect(old).toMatchObject({ id: 'u1', interactive: false })
    expect(old).not.toHaveProperty('subject')
  })

  test('v25 and v26 add guide generated history and chat context; old rows read empty', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hk-sqlite-')), 'store.db')
    const db = new Database(path, { create: true })
    migrate(
      db,
      migrations.filter((m) => m.version <= 24),
    )
    const at = '2026-11-01T00:00:00.000Z'
    const layer = {
      body: '- Run `bun test`.',
      inputHash: 'h1',
      model: 'model-fast',
      costUsd: 0,
      status: 'proposed',
      generatedAt: at,
    }
    db.run('INSERT INTO guides (scope, section, data) VALUES (?, ?, ?)', [
      'repo:gl:acme/widget-kit',
      'testing',
      JSON.stringify({
        scope: 'repo:gl:acme/widget-kit',
        section: 'testing',
        rules: '',
        steering: '',
        version: 0,
        generated: layer,
        proposal: layer,
        learnings: [],
      }),
    ])
    db.run('INSERT INTO chat_threads (id, updated_at, archived, data) VALUES (?, ?, 0, ?)', [
      't1',
      at,
      JSON.stringify({
        id: 't1',
        title: 'Widget rollout',
        createdBy: 'user-1',
        createdAt: at,
        updatedAt: at,
        archived: false,
        autoReply: false,
        participants: ['user-1'],
      }),
    ])
    db.run(
      'INSERT INTO chat_messages (id, thread_id, author_id, created_at, data) VALUES (?, ?, ?, ?, ?)',
      [
        'm1',
        't1',
        'user-1',
        at,
        JSON.stringify({
          id: 'm1',
          threadId: 't1',
          authorType: 'human',
          authorId: 'user-1',
          body: 'Hi',
          mentions: [],
          createdAt: at,
        }),
      ],
    )
    migrate(db)
    expect(versions(db)).toEqual(expect.arrayContaining([25, 26]))
    db.close()

    const { guides, chat } = sqliteStore({ path })
    expect(await guides.get('repo:gl:acme/widget-kit', 'testing')).toMatchObject({
      generated: { ...layer, version: 0 },
      proposal: { ...layer, version: 0 },
    })
    expect(await guides.generatedHistory('repo:gl:acme/widget-kit', 'testing')).toEqual([])

    expect((await chat.getThread('t1'))?.contextRepos).toEqual([])
    expect((await chat.getMessage('m1'))?.refs).toEqual([])
    expect(await chat.context('t1')).toMatchObject({ messageCount: 1, repos: [] })
    expect(await chat.mutedThreads('user-1')).toEqual([])
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
