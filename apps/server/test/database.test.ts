import { describe, expect, test } from 'bun:test'

import type { DatabaseQueries, DatabaseSessionsView, DatabaseView } from '@holtkeeper/api'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { DatabaseIndex, DatabaseInspector, DatabaseTable, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'
import {
  annotateIndexes,
  databaseAdvice,
  databaseHistory,
  domainTotals,
  recordDatabaseSnapshot,
} from '../src/database.ts'
import { databaseStorage } from '../src/storage.ts'

const MB = 1024 * 1024
const now = new Date('2026-10-31T12:00:00.000Z')

const table = (
  name: string,
  totalBytes: number,
  extra: Partial<DatabaseTable> = {},
): DatabaseTable => ({
  name,
  rows: 10,
  dataBytes: totalBytes,
  indexBytes: 0,
  toastBytes: 0,
  totalBytes,
  ...extra,
})

const index = (
  name: string,
  definition: string,
  extra: Partial<DatabaseIndex> = {},
): DatabaseIndex => ({
  name,
  table: 'jobs',
  bytes: 2 * MB,
  scans: 5,
  definition,
  unique: false,
  primary: false,
  ...extra,
})

const overview = {
  engine: 'postgres' as const,
  version: 'PostgreSQL 17.0',
  bytes: 100 * MB,
  cacheHitRatio: 0.999,
  connections: { active: 1, idle: 2, idleInTransaction: 0, waiting: 0, total: 3, max: 100 },
  replicas: [],
}

function fakeInspector(resets: string[] = []): DatabaseInspector {
  return {
    engine: 'postgres',
    overview: async () => overview,
    tables: async () => [table('jobs', 40 * MB), table('library_chunks', 50 * MB), table('kv', MB)],
    indexes: async () => [
      index('jobs_pkey', 'CREATE UNIQUE INDEX jobs_pkey ON s.jobs USING btree (seq)', {
        primary: true,
        unique: true,
      }),
      index('jobs_status', 'CREATE INDEX jobs_status ON s.jobs USING btree (status)', { scans: 0 }),
    ],
    queries: async ({ sort = 'total', limit = 50 } = {}) => ({
      available: true,
      queries: [
        { id: sort, query: 'SELECT $1', calls: limit, totalMs: 1, meanMs: 1, maxMs: 1, rows: 1 },
      ],
      resettable: true,
    }),
    resetQueries: async () => {
      resets.push('reset')
    },
    sessions: async () => [{ pid: 7, state: 'active', query: 'SELECT 1', blockedBy: [3] }],
    migrations: async () => [{ version: 1, appliedAt: '2026-01-01T00:00:00.000Z' }],
  }
}

function appFor(store: Store) {
  const vault = aesVault('v'.repeat(32))
  return createApp({
    config: parseConfig({ forges: {} }),
    auth: noAuth(),
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [],
    analyzers: [],
    now: () => now,
  })
}

describe('annotateIndexes', () => {
  test('marks never-scanned plain indexes unused and repeats of the same columns as duplicates', () => {
    const views = annotateIndexes([
      index('a_big', 'CREATE INDEX a_big ON s.jobs USING btree (status)', { bytes: 5 * MB }),
      index('a_small', 'CREATE INDEX "a_small" ON s.jobs USING btree (status)', {
        bytes: MB,
        scans: 0,
      }),
      index('other_table', 'CREATE INDEX other_table ON s.kv USING btree (status)', {
        table: 'kv',
      }),
      index('pk', 'CREATE UNIQUE INDEX pk ON s.jobs USING btree (seq)', {
        scans: 0,
        unique: true,
        primary: true,
      }),
    ])
    expect(views.map((view) => [view.name, view.unused, view.duplicateOf])).toEqual([
      ['a_big', false, 'a_small'],
      ['a_small', true, undefined],
      ['other_table', false, undefined],
      ['pk', false, undefined],
    ])
  })
})

describe('domainTotals', () => {
  test('groups tables by domain, largest first, with the size about a week ago', () => {
    const totals = domainTotals(
      [
        table('jobs', 30),
        table('ci_jobs', 10),
        table('library_chunks', 50),
        table('library_chunks_fts', 5),
      ],
      [
        { day: '2026-10-20', bytes: 1, domains: { jobs: 5 } },
        { day: '2026-10-24', bytes: 1, domains: { jobs: 20 } },
        { day: '2026-10-30', bytes: 1, domains: { jobs: 39 } },
      ],
      now,
    )
    expect(totals).toEqual([
      { domain: 'libraries', tables: 2, rows: 20, bytes: 55 },
      { domain: 'jobs', tables: 2, rows: 20, bytes: 40, weekAgoBytes: 20 },
    ])
  })
})

describe('databaseAdvice', () => {
  test('reports nothing for a healthy database', () => {
    expect(databaseAdvice({ overview, tables: [table('jobs', MB)], indexes: [], now })).toEqual([])
  })

  test('flags indexes, dead rows, scans, pressure, cache, lag and missing statistics, warnings first', () => {
    const advice = databaseAdvice({
      overview: {
        ...overview,
        cacheHitRatio: 0.8,
        connections: { ...overview.connections, total: 90, idleInTransaction: 2 },
        replicas: [{ name: 'db-2', state: 'streaming', sync: 'async', lagBytes: 64 * MB }],
      },
      tables: [
        table('jobs', MB, { rows: 20_000, deadRows: 10_000, seqScans: 5000, indexScans: 10 }),
      ],
      indexes: annotateIndexes([
        index('jobs_status', 'CREATE INDEX jobs_status ON s.jobs USING btree (status)', {
          scans: 0,
        }),
        index('jobs_status2', 'CREATE INDEX jobs_status2 ON s.jobs USING btree (status)', {
          bytes: 3 * MB,
        }),
      ]),
      queries: { available: false, reason: 'not installed' },
      now,
    })
    expect(advice.map((entry) => [entry.kind, entry.severity, entry.subject])).toEqual([
      ['unused-index', 'warning', 'jobs_status'],
      ['duplicate-index', 'warning', 'jobs_status2'],
      ['dead-rows', 'warning', 'jobs'],
      ['connections', 'warning', 'database'],
      ['cache', 'warning', 'database'],
      ['replication', 'warning', 'db-2'],
      ['stale-analyze', 'info', 'jobs'],
      ['seq-scans', 'info', 'jobs'],
      ['idle-in-transaction', 'info', 'database'],
      ['statements', 'info', 'database'],
    ])
  })

  test('suggests VACUUM for a SQLite file with many free pages', () => {
    const advice = databaseAdvice({
      overview: { engine: 'sqlite', version: 'SQLite 3', bytes: 40 * MB, freeBytes: 20 * MB },
      tables: [],
      indexes: [],
      now,
    })
    expect(advice.map((entry) => entry.kind)).toEqual(['free-space'])
  })
})

describe('database snapshots', () => {
  test('keep one point per day, replacing the same day and dropping points past 90 days', async () => {
    const kv = memoryStore().kv!
    await kv.set('database:history', {
      days: [
        { day: '2026-07-01', bytes: 1, domains: {} },
        { day: '2026-10-30', bytes: 2, domains: {} },
        { day: '2026-10-31', bytes: 3, domains: {} },
      ],
    })
    await recordDatabaseSnapshot(kv, fakeInspector(), now)
    expect(await databaseHistory(kv)).toEqual([
      { day: '2026-10-30', bytes: 2, domains: {} },
      {
        day: '2026-10-31',
        bytes: 100 * MB,
        domains: { jobs: 40 * MB, libraries: 50 * MB, config: MB },
      },
    ])
  })
})

describe('database routes', () => {
  test('explain that the memory store has no database', async () => {
    const app = appFor(memoryStore())
    const view = (await (await app.request('/api/database')).json()) as DatabaseView
    expect(view).toEqual({ available: false, reason: 'The in-memory store keeps no database' })
    expect((await app.request('/api/database/sessions')).status).toBe(404)
  })

  test('serve the overview, statements, sessions and reset', async () => {
    const resets: string[] = []
    const store = { ...memoryStore(), database: fakeInspector(resets) }
    const app = appFor(store)

    const view = (await (await app.request('/api/database')).json()) as DatabaseView
    if (!view.available) throw new Error(view.reason)
    expect(view.tables.map((entry) => [entry.name, entry.domain])).toEqual([
      ['jobs', 'jobs'],
      ['library_chunks', 'libraries'],
      ['kv', 'config'],
    ])
    expect(view.domains.map((domain) => domain.domain)).toEqual(['libraries', 'jobs', 'config'])
    expect(view.advice.map((entry) => entry.subject)).toEqual(['jobs_status'])
    expect(view.resettable).toBe(true)

    const queries = (await (
      await app.request('/api/database/queries?sort=mean&limit=5')
    ).json()) as DatabaseQueries
    expect(queries).toMatchObject({ available: true, queries: [{ id: 'mean', calls: 5 }] })
    expect((await app.request('/api/database/queries?sort=bogus')).status).toBe(400)

    const sessions = (await (
      await app.request('/api/database/sessions')
    ).json()) as DatabaseSessionsView
    expect(sessions.sessions).toEqual([
      { pid: 7, state: 'active', query: 'SELECT 1', blockedBy: [3] },
    ])

    const reset = await app.request('/api/database/queries/reset', { method: 'POST' })
    expect(reset.status).toBe(200)
    expect(resets).toEqual(['reset'])
    const [entry] = await store.activity.list({ limit: 1 })
    expect(entry?.action).toBe('database.queries-reset')
  })

  test('report inspection failures as unavailable', async () => {
    const failing: DatabaseInspector = {
      ...fakeInspector(),
      overview: async () => {
        throw new Error('permission denied for pg_stat_database')
      },
    }
    const app = appFor({ ...memoryStore(), database: failing })
    expect(await (await app.request('/api/database')).json()).toEqual({
      available: false,
      reason: 'permission denied for pg_stat_database',
    })
  })
})

describe('databaseStorage', () => {
  test('reports a Postgres database by domain', async () => {
    const usage = await databaseStorage(undefined, fakeInspector()).usage()
    expect(usage.bytes).toBe(100 * MB)
    expect(usage.details?.map((detail) => detail.label)).toEqual(['libraries', 'jobs', 'config'])
  })
})
