import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { KnowledgeEntryInput, Store } from '@holtkeeper/store'

import { ftsQuery } from './knowledge.ts'
import { migrate, migrations } from './migrations.ts'
import { sqliteStore } from './sqlite.ts'

const entry = (
  id: string,
  title: string,
  body: string,
  topics: string[] = [],
): KnowledgeEntryInput => ({
  id,
  title,
  body,
  kind: 'decision',
  scope: { all: true },
  topics,
  appliesTo: ['*'],
  status: 'accepted',
  source: 'human',
  author: 'jane',
  evidence: [],
  createdAt: '2026-10-30T09:00:00.000Z',
  updatedAt: '2026-10-30T09:00:00.000Z',
})

describe('ftsQuery', () => {
  test('quotes every word as a prefix term and drops syntax', () => {
    expect(ftsQuery('react migr')).toBe('"react"* OR "migr"*')
    expect(ftsQuery('"a" AND b* NEAR(c, d) -e col:f')).toBe(
      '"a"* OR "and"* OR "b"* OR "near"* OR "c"* OR "d"* OR "e"* OR "col"* OR "f"*',
    )
    expect(ftsQuery('Ünïcode ünïcode')).toBe('"ünïcode"*')
    expect(ftsQuery(' "*()" ')).toBeUndefined()
  })
})

describe('sqlite knowledge search', () => {
  let store: Store
  beforeEach(() => {
    store = sqliteStore({ path: ':memory:' })
  })
  afterEach(async () => {
    await store.close()
  })

  test('bm25 prefers more matching words and denser matches', async () => {
    await store.knowledge.put(entry('one', 'Locale files', 'Translations live in locales.'))
    await store.knowledge.put(
      entry('both', 'Locale fallback', 'Missing translations fall back to en.'),
    )
    await store.knowledge.put(entry('none', 'Snapshots', 'No snapshots.'))
    const hits = await store.knowledge.search('fallback translations')
    expect(hits.map((h) => h.entry.id)).toEqual(['both', 'one'])
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0)
    expect(hits.every((h) => h.score > 0)).toBeTrue()
  })

  test('diacritics are folded and package names are searchable', async () => {
    await store.knowledge.put({
      ...entry('react', 'Hooks rules', 'Use the café pattern.'),
      kind: 'migration',
      packages: [{ ecosystem: 'npm', name: 'react', from: '>=18 <19', to: '>=19 <20' }],
    })
    expect((await store.knowledge.search('cafe')).map((h) => h.entry.id)).toEqual(['react'])
    expect((await store.knowledge.search('rea')).map((h) => h.entry.id)).toEqual(['react'])
  })

  test('the index follows updates and deletes', async () => {
    await store.knowledge.put(entry('k', 'Old title', 'Body about webpack.'))
    await store.knowledge.put(entry('k', 'New title', 'Body about vite.'))
    expect(await store.knowledge.search('webpack')).toEqual([])
    expect((await store.knowledge.search('vite')).map((h) => h.entry.version)).toEqual([2])
    await store.knowledge.remove('k')
    expect(await store.knowledge.search('vite')).toEqual([])
  })

  test('filters and limit apply inside the ranked query', async () => {
    for (let i = 0; i < 5; i++) await store.knowledge.put(entry(`a${i}`, `Testing ${i}`, 'mocks'))
    await store.knowledge.put({ ...entry('p', 'Testing proposal', 'mocks'), status: 'proposed' })
    expect(await store.knowledge.search('testing', { status: 'accepted' }, 3)).toHaveLength(3)
    expect(
      (await store.knowledge.search('mocks', { status: 'proposed' })).map((h) => h.entry.id),
    ).toEqual(['p'])
  })
})

describe('knowledge migration', () => {
  test('v4 upgrades a v3 database and indexes nothing stale', async () => {
    const db = new Database(':memory:')
    migrate(
      db,
      migrations.filter((m) => m.version <= 3),
    )
    db.run(`INSERT INTO activity (id, at, actor, action) VALUES ('e1', 'now', 'root', 'x')`)
    migrate(db)
    const version = db
      .query<{ v: number }, []>('SELECT MAX(version) AS v FROM schema_migrations')
      .get()
    expect(version?.v).toBe(Math.max(...migrations.map((m) => m.version)))
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM knowledge_fts').get()?.n).toBe(0)
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM activity').get()?.n).toBe(1)
    db.close()
  })
})
