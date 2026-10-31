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
        ('next', 'changelog', 'work', 'games/a', '{}', 'manual', 'queued', 0, 3, $1, $1)`,
      ['2026-10-30T10:00:00.000Z'],
    )
    expect(await migrate(admin!, schema)).toEqual(migrations.slice(8).map((step) => step.version))
    const store = postgresStore({ url: url!, schema })
    expect((await store.jobs.claim('w1', '2026-10-30T11:00:00.000Z'))?.id).toBe('next')
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
    const event = await store.activity.append({
      at: '2026-10-01T02:30:00+02:00',
      actor: 'root',
      action: 'a.b',
    })
    expect(event.at).toBe('2026-10-01T00:30:00.000Z')
    expect((await store.activity.list())[0]?.at).toBe('2026-10-01T00:30:00.000Z')
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
