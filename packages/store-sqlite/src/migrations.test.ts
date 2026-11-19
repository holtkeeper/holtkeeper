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

  test('v26 adds chat context; old rows read empty', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hk-sqlite-')), 'store.db')
    const db = new Database(path, { create: true })
    migrate(
      db,
      migrations.filter((m) => m.version <= 24),
    )
    const at = '2026-11-01T00:00:00.000Z'
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

    const { chat } = sqliteStore({ path })
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

  test('v30 renames ai usage groups to teams', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hk-sqlite-')), 'store.db')
    const db = new Database(path, { create: true })
    migrate(
      db,
      migrations.filter((m) => m.version <= 29),
    )
    db.run(
      `INSERT INTO ai_usage (id, at, repo_forge, repo_path, groups, task_kind, actor, provider, model,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, cost_source,
         duration_ms, turns, outcome)
       VALUES ('u1', '2026-10-01T00:00:00.000Z', 'work', 'shapes/a', '["widgets"]', 'review',
         'system', 'anthropic', 'm', 1, 1, 0, 0, 0.5, 'reported', 10, 1, 'ok')`,
    )
    migrate(db)
    expect(versions(db)).toContain(30)
    db.close()
    const { aiUsage } = sqliteStore({ path })
    expect((await aiUsage.list({ team: 'widgets' }))[0]).toMatchObject({
      id: 'u1',
      teams: ['widgets'],
    })
  })

  test('v32 deletes slack.reviews entries and keeps other settings', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hk-sqlite-')), 'store.db')
    const db = new Database(path, { create: true })
    migrate(
      db,
      migrations.filter((m) => m.version <= 31),
    )
    const insert = (id: string, key: string) =>
      db.run(
        `INSERT INTO settings (id, key, scope, value, secret, updated_at)
         VALUES (?, ?, '{"all":true}', '{}', 0, '2026-10-01T00:00:00.000Z')`,
        [id, key],
      )
    insert('s1', 'slack.reviews')
    insert('s2', 'releases.announce')
    migrate(db)
    expect(versions(db)).toContain(32)
    db.close()
    const { settings } = sqliteStore({ path })
    expect((await settings.list()).map((entry) => entry.key)).toEqual(['releases.announce'])
  })
  test('v34 replaces notes, guides, families and embeddings with rules and learnings', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hk-sqlite-')), 'store.db')
    const db = new Database(path, { create: true })
    migrate(
      db,
      migrations.filter((m) => m.version <= 33),
    )
    const at = '2026-11-01T00:00:00.000Z'
    db.run(
      `INSERT INTO knowledge (id, title, body, kind, status, source, author, scope, topics,
         applies_to, evidence, tags, created_at, updated_at, version)
       VALUES ('k1', 'Round corners', 'Use the radius token.', 'convention', 'accepted', 'human',
         'jane', '{"teams":["widgets"]}', '[]', '["*"]', '[]', '', ?1, ?1, 1)`,
      [at],
    )
    db.run(
      `INSERT INTO learnings (id, repo, key, created_at, data) VALUES ('l1', 'work:a', 'k', ?, '{}')`,
      [at],
    )
    db.run(`INSERT INTO learning_claims (key, at) VALUES ('work:a!1#2', ?)`, [at])
    migrate(db)
    expect(versions(db)).toContain(34)
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger')",
      )
      .all()
      .map((row) => row.name)
    for (const gone of [
      'knowledge',
      'knowledge_history',
      'knowledge_fts',
      'knowledge_fts_insert',
      'guides',
      'guide_history',
      'guide_generated',
      'families',
      'embeddings',
    ])
      expect(tables).not.toContain(gone)
    expect(tables).toEqual(
      expect.arrayContaining([
        'rules',
        'rule_history',
        'rules_fts',
        'learnings',
        'learnings_fts',
        'learning_claims',
        'review_reactions',
      ]),
    )
    db.close()

    const { rules, learnings } = sqliteStore({ path })
    expect(await learnings.list()).toEqual([])
    expect(await learnings.claim('work:a!1#2', at)).toBe(false)
    await rules.put({
      id: 'r1',
      title: 'Round corners',
      body: 'Use the radius token.',
      scope: { teams: ['widgets'] },
      author: 'jane',
      createdAt: at,
      updatedAt: at,
    })
    expect((await rules.search('radius')).map((hit) => hit.rule.id)).toEqual(['r1'])
  })

  test('v36 fills merge request and phase of earlier review spend', () => {
    const db = new Database(':memory:')
    migrate(
      db,
      migrations.filter((m) => m.version <= 35),
    )
    const job = (id: string, options: string, analysis: string | null, analyzer = 'review') =>
      db.run(
        `INSERT INTO jobs (id, analyzer, repo_forge, repo_path, options, trigger, status, attempts,
           max_attempts, run_after, created_at, analysis_id)
         VALUES (?, ?, 'work', 'shapes/a', ?, 'webhook', 'done', 1, 3, 'now', 'now', ?)`,
        [id, analyzer, options, analysis],
      )
    const analysis = (id: string, ref: string, at: string, mode: string) =>
      db.run(
        `INSERT INTO analyses (id, repo_forge, repo_path, kind, ref, created_at, data, metrics)
         VALUES (?, 'work', 'shapes/a', 'review', ?, ?, '{}', ?)`,
        [id, ref, at, JSON.stringify({ mode })],
      )
    const usage = (id: string, at: string, jobId: string, kind: string, subject: string | null) =>
      db.run(
        `INSERT INTO ai_usage (id, at, repo_forge, repo_path, teams, task_kind, job_id, actor,
           interactive, subject, provider, model, input_tokens, output_tokens, cache_read_tokens,
           cache_write_tokens, cost_usd, cost_source, duration_ms, turns, outcome)
         VALUES (?, ?, 'work', 'shapes/a', '[]', ?, ?, 'system', 0, ?, 'anthropic', 'm', 0, 0, 0, 0,
           0.1, 'price', 0, 1, 'ok')`,
        [id, at, kind, jobId, subject],
      )
    analysis('a1', '!7', '2026-11-12T10:05:00.000Z', 'full')
    analysis('a2', '!7', '2026-11-13T10:05:00.000Z', 'incremental')
    analysis('a3', '!7', '2026-11-13T12:05:00.000Z', 'reply')
    job('j1', '{"mergeRequest":7}', 'a1')
    job('j2', '{"mergeRequest":7}', 'a2')
    job('j3', '{"replies":true,"mergeRequest":7}', 'a3')
    job('j4', '{}', null)
    job('j5', '{}', null, 'coverage')
    usage('u1', '2026-11-12T10:00:00.000Z', 'j1', 'review', 'MR !7')
    usage('u2', '2026-11-12T10:01:00.000Z', 'j1', 'review-verify', 'MR !7')
    usage('u3', '2026-11-13T10:00:00.000Z', 'j2', 'review', 'MR !7')
    usage('u4', '2026-11-13T12:00:00.000Z', 'j3', 'review', 'MR !7')
    usage('u5', '2026-11-14T09:00:00.000Z', 'j4', 'review', 'MR !9')
    usage('u6', '2026-11-14T09:00:00.000Z', 'j5', 'triage', null)
    usage('u7', '2026-11-13T10:02:00.000Z', 'j2', 'triage', 'MR !7')
    db.run(`UPDATE ai_usage SET phase = 'recheck', merge_request = 3 WHERE id = 'u7'`)
    migrate(db)
    expect(
      db
        .query<{ id: string; merge_request: number | null; phase: string | null }, []>(
          'SELECT id, merge_request, phase FROM ai_usage ORDER BY id',
        )
        .all(),
    ).toEqual([
      { id: 'u1', merge_request: 7, phase: 'initial' },
      { id: 'u2', merge_request: 7, phase: 'initial' },
      { id: 'u3', merge_request: 7, phase: 'update' },
      { id: 'u4', merge_request: 7, phase: 'reply' },
      { id: 'u5', merge_request: 9, phase: 'initial' },
      { id: 'u6', merge_request: null, phase: null },
      { id: 'u7', merge_request: 3, phase: 'recheck' },
    ])
    db.close()
  })
})
