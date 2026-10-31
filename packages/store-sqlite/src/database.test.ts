import { describe, expect, test } from 'bun:test'

import { sqliteStore } from './sqlite.ts'

describe('sqlite database inspector', () => {
  const store = sqliteStore({ path: ':memory:' })
  const inspector = store.database!

  test('overview reports the file size from pages', async () => {
    const overview = await inspector.overview()
    expect(overview.engine).toBe('sqlite')
    expect(overview.version).toStartWith('SQLite ')
    expect(overview.bytes).toBeGreaterThan(0)
    expect(overview.freeBytes).toBeGreaterThanOrEqual(0)
  })

  test('tables have exact row counts and sizes', async () => {
    await store.activity.append({ at: '2026-10-31T00:00:00.000Z', actor: 'a', action: 'x' })
    await store.activity.append({ at: '2026-10-31T00:00:01.000Z', actor: 'a', action: 'y' })
    const tables = await inspector.tables()
    const activity = tables.find((table) => table.name === 'activity')
    expect(activity?.rows).toBe(2)
    expect(activity?.totalBytes).toBe(activity!.dataBytes + activity!.indexBytes)
    expect(tables.some((table) => table.name.startsWith('sqlite_'))).toBe(false)
  })

  test('indexes include constraint indexes', async () => {
    const indexes = await inspector.indexes()
    const activity = indexes.filter((index) => index.table === 'activity')
    expect(activity.some((index) => index.unique)).toBe(true)
  })

  test('no statement statistics or sessions; migrations in order', async () => {
    expect(await inspector.queries()).toEqual({
      available: false,
      reason: 'SQLite keeps no statement statistics',
    })
    expect(await inspector.sessions()).toEqual([])
    const migrations = await inspector.migrations()
    expect(migrations[0]?.version).toBe(1)
    expect(typeof migrations[0]?.appliedAt).toBe('string')
  })
})
