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
    await store.audit.append({
      at: '2026-10-31T00:00:00.000Z',
      actor: { id: 'a', name: 'A', provider: 'users' },
      via: 'api',
      action: 'x.a',
      target: { type: 'x' },
      outcome: 'ok',
    })
    await store.audit.append({
      at: '2026-10-31T00:00:01.000Z',
      actor: { id: 'a', name: 'A', provider: 'users' },
      via: 'api',
      action: 'x.b',
      target: { type: 'x' },
      outcome: 'ok',
    })
    const tables = await inspector.tables()
    const events = tables.find((table) => table.name === 'audit_events')
    expect(events?.rows).toBe(2)
    expect(events?.totalBytes).toBe(events!.dataBytes + events!.indexBytes)
    expect(tables.some((table) => table.name.startsWith('sqlite_'))).toBe(false)
  })

  test('indexes include constraint indexes', async () => {
    const indexes = await inspector.indexes()
    const events = indexes.filter((index) => index.table === 'audit_events')
    expect(events.some((index) => index.unique)).toBe(true)
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
