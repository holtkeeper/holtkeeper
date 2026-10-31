import { afterAll, describe, expect, test } from 'bun:test'

import { SQL } from 'bun'

import { postgresStore } from './postgres.ts'

const url = process.env.HOLTKEEPER_PG_URL
const schema = `holtkeeper_inspect_${process.pid}_${Date.now().toString(36)}`
const admin = url ? new SQL(url, { max: 1 }) : undefined
const store = url ? postgresStore({ url, schema, max: 2 }) : undefined

const inspector = () => store!.database!

afterAll(async () => {
  await store?.close()
  if (!admin) return
  await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`
  await admin.close()
})

describe.skipIf(!url || !store)('postgres database inspector (HOLTKEEPER_PG_URL)', () => {
  test('overview reports size, version and connections', async () => {
    const overview = await inspector().overview()
    expect(overview.engine).toBe('postgres')
    expect(overview.version).toStartWith('PostgreSQL ')
    expect(overview.bytes).toBeGreaterThan(0)
    expect(overview.connections?.total).toBeGreaterThan(0)
    expect(overview.connections?.max).toBeGreaterThan(0)
    expect(overview.standby).toBe(false)
  })

  test('tables and indexes cover only the store schema', async () => {
    await store!.activity.append({ at: new Date().toISOString(), actor: 'a', action: 'test' })
    const tables = await inspector().tables()
    const names = tables.map((table) => table.name)
    expect(names).toContain('activity')
    expect(names).toContain('schema_migrations')
    const activity = tables.find((table) => table.name === 'activity')!
    expect(activity.totalBytes).toBeGreaterThanOrEqual(activity.dataBytes + activity.indexBytes)
    const indexes = await inspector().indexes()
    expect(indexes.some((index) => index.table === 'activity' && index.primary)).toBe(true)
    expect(indexes.every((index) => names.includes(index.table))).toBe(true)
  })

  test('statements are listed or explained', async () => {
    const result = await inspector().queries({ sort: 'calls', limit: 5 })
    if (result.available) expect(result.queries.length).toBeLessThanOrEqual(5)
    else expect(result.reason).toBeTruthy()
  })

  test('sessions exclude the inspecting connection and migrations are ordered', async () => {
    const sessions = await inspector().sessions()
    expect(sessions.every((session) => Array.isArray(session.blockedBy))).toBe(true)
    const migrations = await inspector().migrations()
    expect(migrations[0]?.version).toBe(1)
    expect(migrations.map((m) => m.version)).toEqual(
      migrations.map((m) => m.version).toSorted((a, b) => a - b),
    )
  })
})
