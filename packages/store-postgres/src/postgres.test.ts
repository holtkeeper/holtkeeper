import { afterAll, describe, expect, test } from 'bun:test'

import { describeStoreContract } from '@holtkeeper/store/testing'
import { SQL } from 'bun'

import { type Migration, migrate, migrations } from './migrations.ts'
import { postgresStore, resolveUrl } from './postgres.ts'

const url = process.env.HOLTKEEPER_PG_URL
const run = `${process.pid}_${Date.now().toString(36)}`
let seq = 0
const schemas: string[] = []
const nextSchema = () => {
  const schema = `holtkeeper_test_${run}_${seq++}`
  schemas.push(schema)
  return schema
}

const admin = url ? new SQL(url, { max: 2 }) : undefined
afterAll(async () => {
  if (!admin) return
  await Promise.all(schemas.map((schema) => admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`))
  await admin.close()
})

describe.skipIf(!url || !admin)('postgres (HOLTKEEPER_PG_URL)', () => {
  describeStoreContract('postgres', async () => {
    const schema = nextSchema()
    const store = postgresStore({ url: url!, schema, max: 4 })
    return {
      ...store,
      async close() {
        await store.close()
        await admin!`DROP SCHEMA IF EXISTS ${admin!(schema)} CASCADE`
      },
    }
  })
})

const versions = async (schema: string) =>
  (
    (await admin!`SELECT version FROM ${admin!(`${schema}.schema_migrations`)} ORDER BY version`) as {
      version: number
    }[]
  ).map((row) => row.version)

describe.skipIf(!url || !admin)('postgres store', () => {
  test('stores started together migrate once and data survives a restart', async () => {
    const schema = nextSchema()
    const stores = Array.from({ length: 4 }, () => postgresStore({ url: url!, schema, max: 2 }))
    await Promise.all(stores.map((store) => store.ready()))
    expect(await versions(schema)).toEqual(migrations.map((m) => m.version))
    await stores[0]!.settings.put({
      id: 's1',
      key: 'llm.model',
      scope: { all: true },
      value: 'claude-opus-5-5',
      secret: false,
      updatedAt: '2026-10-01T00:00:00.000Z',
    })
    await Promise.all(stores.map((store) => store.close()))

    const reopened = postgresStore({ url: url!, schema })
    expect((await reopened.settings.get('s1'))?.value).toBe('claude-opus-5-5')
    await reopened.close()
  })

  test('migrate applies a lower version added after a higher one', async () => {
    const schema = nextSchema()
    const one: Migration = { version: 1, sql: 'CREATE TABLE a (x text)' }
    const two: Migration = { version: 2, sql: 'CREATE TABLE b (x text)' }
    const three: Migration = { version: 3, sql: 'CREATE TABLE c (x text)' }
    expect(await migrate(admin!, schema, [one, three])).toEqual([1, 3])
    expect(await migrate(admin!, schema, [one, two, three])).toEqual([2])
    expect(await migrate(admin!, schema, [one, two, three])).toEqual([])
    expect(await versions(schema)).toEqual([1, 2, 3])
  })

  test('a failing step rolls the whole migration back', async () => {
    const schema = nextSchema()
    const good: Migration = { version: 1, sql: 'CREATE TABLE a (x text)' }
    const bad: Migration = { version: 2, sql: 'CREATE TABLE b (x nonsense_type)' }
    expect(migrate(admin!, schema, [good, bad])).rejects.toThrow()
    const [row] = await admin!`SELECT to_regclass(${`${schema}.a`}) AS a`
    expect(row.a).toBeNull()
  })

  test('concurrent claims keep exclusive jobs alone and one job per analyzer', async () => {
    const store = postgresStore({ url: url!, schema: nextSchema(), max: 8 })
    const analyzers = ['bundle', 'bundle', 'changelog', 'coverage']
    for (let i = 0; i < 8; i++)
      // oxlint-disable-next-line no-await-in-loop -- creation order decides which job is oldest
      await store.jobs.enqueue({
        analyzer: i < 4 ? (analyzers[i] ?? 'bundle') : 'port',
        repo: { forge: 'work', path: i < 4 ? 'games/shared' : `games/fix-${i % 2}` },
        trigger: 'manual',
        createdAt: `2026-10-30T10:0${i}:00.000Z`,
      })
    const claimed = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.jobs.claim(`w${i}`, '2026-10-30T11:00:00.000Z', { exclusive: ['port'] }),
      ),
    )
    const started = claimed.flatMap((job) => (job ? [`${job.repo.path} ${job.analyzer}`] : []))
    expect(started.toSorted()).toEqual([
      'games/fix-0 port',
      'games/fix-1 port',
      'games/shared bundle',
      'games/shared changelog',
      'games/shared coverage',
    ])
    await store.close()
  })

  test('concurrent claims never start a reader next to an exclusive job', async () => {
    const store = postgresStore({ url: url!, schema: nextSchema(), max: 8 })
    for (let round = 0; round < 10; round++) {
      const path = `games/${round}`
      for (const [i, analyzer] of ['changelog', 'port', 'bundle', 'coverage'].entries())
        // oxlint-disable-next-line no-await-in-loop -- creation order decides which job is oldest
        await store.jobs.enqueue({
          analyzer,
          repo: { forge: 'work', path },
          trigger: 'manual',
          createdAt: `2026-10-30T10:0${i}:00.000Z`,
          runAfter: `2026-10-30T10:0${round % 2 ? 3 - i : i}:00.000Z`,
        })
    }
    const claimed = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        store.jobs.claim(`w${i}`, '2026-10-30T11:00:00.000Z', { exclusive: ['port'] }),
      ),
    )
    const byRepo = Map.groupBy(
      claimed.flatMap((job) => (job ? [job] : [])),
      (job) => job.repo.path,
    )
    for (const jobs of byRepo.values()) {
      if (jobs.some((job) => job.analyzer === 'port')) expect(jobs).toHaveLength(1)
    }
    await store.close()
  })

  test('migration 9 relaxes the running-job index of an existing database', async () => {
    const schema = nextSchema()
    await migrate(admin!, schema, migrations.slice(0, 8))
    await admin!.unsafe(
      `
      INSERT INTO ${schema}.jobs (id, analyzer, repo_forge, repo_path, options, trigger, status,
        attempts, max_attempts, run_after, created_at)
      VALUES ('old', 'bundle', 'work', 'games/a', '{}', 'manual', 'running', 1, 3, $1, $1),
        ('next', 'depgraph', 'work', 'games/a', '{}', 'manual', 'queued', 0, 3, $1, $1)`,
      ['2026-10-30T10:00:00.000Z'],
    )
    expect(await migrate(admin!, schema)).toEqual(migrations.slice(8).map((step) => step.version))
    const store = postgresStore({ url: url!, schema })
    expect((await store.jobs.claim('w1', '2026-10-30T11:00:00.000Z'))?.id).toBe('next')
    await store.close()
  })

  test('migrations 24 and 25 add guide generated history and chat context; old rows read empty', async () => {
    const schema = nextSchema()
    await migrate(
      admin!,
      schema,
      migrations.filter((step) => step.version <= 23),
    )
    const at = '2026-11-01T00:00:00.000Z'
    const layer = {
      body: '- Run `bun test`.',
      inputHash: 'h1',
      model: 'model-fast',
      costUsd: 0,
      status: 'proposed' as const,
      generatedAt: at,
    }
    await admin!.unsafe(`INSERT INTO ${schema}.guides (scope, section, data) VALUES ($1, $2, $3)`, [
      'repo:gl:acme/widget-kit',
      'testing',
      {
        scope: 'repo:gl:acme/widget-kit',
        section: 'testing',
        rules: '',
        steering: '',
        version: 0,
        generated: layer,
        proposal: layer,
        learnings: [],
      },
    ])
    await admin!.unsafe(
      `INSERT INTO ${schema}.chat_threads (id, updated_at, archived, data) VALUES ($1, $2, false, $3)`,
      [
        't1',
        at,
        {
          id: 't1',
          title: 'Widget rollout',
          createdBy: 'user-1',
          createdAt: at,
          updatedAt: at,
          archived: false,
          autoReply: false,
          participants: ['user-1'],
        },
      ],
    )
    await admin!.unsafe(
      `INSERT INTO ${schema}.chat_messages (id, thread_id, author_id, created_at, data)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        'm1',
        't1',
        'user-1',
        at,
        {
          id: 'm1',
          threadId: 't1',
          authorType: 'human',
          authorId: 'user-1',
          body: 'Hi',
          mentions: [],
          createdAt: at,
        },
      ],
    )
    expect(await migrate(admin!, schema)).toEqual(
      migrations.filter((step) => step.version > 23).map((step) => step.version),
    )
    const store = postgresStore({ url: url!, schema })
    expect(await store.guides.get('repo:gl:acme/widget-kit', 'testing')).toMatchObject({
      generated: { ...layer, version: 0 },
      proposal: { ...layer, version: 0 },
    })
    expect(await store.guides.generatedHistory('repo:gl:acme/widget-kit', 'testing')).toEqual([])
    expect((await store.chat.getThread('t1'))?.contextRepos).toEqual([])
    expect((await store.chat.getMessage('m1'))?.refs).toEqual([])
    expect(await store.chat.context('t1')).toMatchObject({ messageCount: 1, repos: [] })
    await store.close()
  })

  test('migration 21 removes what retired analyzers and settings left behind', async () => {
    const schema = nextSchema()
    await migrate(
      admin!,
      schema,
      migrations.filter((step) => step.version <= 20),
    )
    const at = '2026-11-01T00:00:00.000Z'
    await admin!.unsafe(
      `
      INSERT INTO ${schema}.analyses (id, repo_forge, repo_path, kind, created_at, data)
      VALUES ('a1', 'work', 'shapes/a', 'quality', $1, '{}'),
        ('a2', 'work', 'shapes/a', 'depgraph', $1, '{}');
      `,
      [at],
    )
    await admin!.unsafe(
      `
      INSERT INTO ${schema}.jobs (id, analyzer, repo_forge, repo_path, options, trigger, status,
        attempts, max_attempts, run_after, created_at)
      VALUES ('j1', 'warmup', 'work', 'shapes/a', '{}', 'manual', 'queued', 0, 3, $1, $1),
        ('j2', 'bundle', 'work', 'shapes/a', '{}', 'manual', 'queued', 0, 3, $1, $1)`,
      [at],
    )
    await admin!.unsafe(
      `
      INSERT INTO ${schema}.settings (id, key, scope, value, secret, updated_at)
      VALUES ('s1', 'analyzers.port', '{"all":true}', '{}', false, $1),
        ('s2', 'analyzers.bundle', '{"all":true}', '{}', false, $1)`,
      [at],
    )
    await admin!.unsafe(
      `INSERT INTO ${schema}.kv (key, value)
       VALUES ('digests', '[]'), ('chat:slack:policy', '{}'), ('chat:slack:connection', '{}')`,
    )
    const docs = [
      [
        'schedule',
        'mixed',
        {
          name: 'Mixed',
          enabled: true,
          analyzers: ['changelog', 'bundle', 'release-risk', 'coverage'],
          options: { 'release-risk': { x: 1 }, bundle: { y: 2 } },
        },
      ],
      ['schedule', 'gone', { name: 'Gone', enabled: true, analyzers: ['fleet', 'delivery'] }],
      ['trigger', 'cmd', { on: 'command', command: 'port', analyzer: 'port' }],
      ['trigger', 'new-repo', { on: 'newRepo' }],
    ] as const
    for (const [type, id, data] of docs)
      // oxlint-disable-next-line no-await-in-loop -- a few rows
      await admin!.unsafe(
        `INSERT INTO ${schema}.config_documents (type, id, data, version, updated_at, updated_by)
         VALUES ($1, $2, '${JSON.stringify(data)}'::jsonb, 1, $3, 'person')`,
        [type, id, at],
      )

    expect(await migrate(admin!, schema)).toContain(21)
    const store = postgresStore({ url: url!, schema })
    const { kv, config } = store
    if (!kv || !config) throw new Error('the postgres store has kv and config')
    expect((await store.analyses.list({})).map((record) => record.id)).toEqual(['a2'])
    expect((await store.jobs.list()).map((job) => job.id)).toEqual(['j2'])
    expect((await store.settings.list()).map((entry) => entry.id)).toEqual(['s2'])
    expect(await kv.get('digests')).toBeUndefined()
    expect(await kv.get('chat:slack:policy')).toBeUndefined()
    expect(await kv.get('chat:slack:connection')).toEqual({})
    expect(await config.get('schedule', 'gone')).toBeUndefined()
    expect(await config.get('trigger', 'cmd')).toBeUndefined()
    expect(await config.get('schedule', 'mixed')).toMatchObject({
      version: 2,
      updatedBy: 'system',
      data: { analyzers: ['bundle', 'coverage'], options: { bundle: { y: 2 } } },
    })
    expect((await config.history('schedule', 'mixed')).map((each) => each.version)).toEqual([1])
    expect(await config.get('trigger', 'new-repo')).toMatchObject({ version: 1 })
    await store.close()
  })

  test('migration 23 adds ai usage origin and subject and indexes jobs by analysis', async () => {
    const schema = nextSchema()
    await migrate(
      admin!,
      schema,
      migrations.filter((step) => step.version <= 22),
    )
    await admin!.unsafe(
      `
      INSERT INTO ${schema}.ai_usage (id, at, repo_forge, repo_path, groups, task_kind, actor, provider,
        model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
        cost_source, duration_ms, turns, outcome)
      VALUES ('u1', $1, 'work', 'shapes/a', '[]', 'review', 'system', 'anthropic', 'm', 1, 1, 0, 0,
        0.5, 'reported', 10, 1, 'ok')`,
      ['2026-10-01T00:00:00.000Z'],
    )
    expect(await migrate(admin!, schema)).toContain(23)
    const indexes =
      (await admin!`SELECT indexname FROM pg_indexes WHERE schemaname = ${schema}`) as {
        indexname: string
      }[]
    expect(indexes.map((row) => row.indexname)).toEqual(
      expect.arrayContaining(['jobs_analysis', 'ai_usage_actor_at', 'ai_usage_job']),
    )
    const store = postgresStore({ url: url!, schema })
    const [old] = await store.aiUsage.list()
    expect(old).toMatchObject({ id: 'u1', interactive: false })
    expect(old).not.toHaveProperty('subject')
    await store.close()
  })

  test('foreign keys reject passkeys of unknown users', async () => {
    const store = postgresStore({ url: url!, schema: nextSchema() })
    const outcome = await store.users
      .putPasskey({ id: 'pk', userId: 'nobody', publicKey: 'k', counter: 0, createdAt: 'now' })
      .then(
        () => 'saved',
        () => 'rejected',
      )
    expect(outcome).toBe('rejected')
    await store.close()
  })

  test('timestamps come back in the contract form, whatever offset they were written with', async () => {
    const store = postgresStore({ url: url!, schema: nextSchema() })
    const stored = await store.auditRuns.add({
      repo: { forge: 'work', path: 'games/a' },
      trigger: 'manual',
      startedAt: '2026-10-01T02:00:00+02:00',
      finishedAt: '2026-10-01T02:30:00+02:00',
      report: { findings: [], scanned: [], errors: [] } as never,
    })
    expect(stored.finishedAt).toBe('2026-10-01T00:30:00.000Z')
    expect((await store.auditRuns.list())[0]?.finishedAt).toBe('2026-10-01T00:30:00.000Z')
    await store.close()
  })

  test('search folds accents and survives hostile input', async () => {
    const store = postgresStore({ url: url!, schema: nextSchema() })
    await store.knowledge.put({
      id: 'k',
      title: 'Café menus',
      body: "Backslash \\ and quote ' are fine",
      kind: 'quirk',
      scope: { all: true },
      topics: [],
      appliesTo: ['*'],
      status: 'accepted',
      evidence: [],
      source: 'human',
      author: 'jane',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    })
    expect((await store.knowledge.search('cafe')).map((hit) => hit.entry.id)).toEqual(['k'])
    expect((await store.knowledge.search("\\ ' '' :* & | ! <->")).length).toBe(0)
    await store.close()
  })
})

describe('postgres store without a database', () => {
  test('creating a store does not connect or read the URL', async () => {
    const store = postgresStore({ url: { env: 'HOLTKEEPER_PG_TEST_UNSET_VARIABLE' } })
    expect(store.ready()).rejects.toThrow('HOLTKEEPER_PG_TEST_UNSET_VARIABLE is not set')
    await store.close()
  })

  test('rejects schema names that need quoting', () => {
    expect(() => postgresStore({ url: 'postgres://x', schema: 'Bad-Name' })).toThrow('schema')
  })

  test('resolveUrl reads literals and environment references', () => {
    process.env.HOLTKEEPER_PG_TEST_URL = 'postgres://from-env'
    expect(resolveUrl('postgres://literal')).toBe('postgres://literal')
    expect(resolveUrl({ env: 'HOLTKEEPER_PG_TEST_URL' })).toBe('postgres://from-env')
    delete process.env.HOLTKEEPER_PG_TEST_URL
  })
})
