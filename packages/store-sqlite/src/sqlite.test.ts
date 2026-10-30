import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describeStoreContract } from '@holtkeeper/store/testing'

import { migrations } from './migrations.ts'
import { sqliteStore } from './sqlite.ts'

describeStoreContract('sqlite', () => sqliteStore({ path: ':memory:' }))

describe('sqlite store files', () => {
  let dir: string | undefined
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  test('data survives reopening the file and migrations are idempotent', async () => {
    dir = await mkdtemp(join(tmpdir(), 'holtkeeper-sqlite-'))
    const path = join(dir, 'store.db')

    const first = sqliteStore({ path })
    await first.settings.put({
      id: 's1',
      key: 'llm.model',
      scope: { all: true },
      value: { name: 'x' },
      secret: false,
      updatedAt: '2026-10-01T00:00:00.000Z',
    })
    await first.close()

    const second = sqliteStore({ path })
    expect((await second.settings.get('s1'))?.value).toEqual({ name: 'x' })
    await second.close()

    const db = new Database(path, { readonly: true })
    const versions = db
      .query<{ version: number }, []>('SELECT version FROM schema_migrations ORDER BY version')
      .all()
    db.close()
    expect(versions.map((v) => v.version)).toEqual(migrations.map((m) => m.version))
  })

  test('uses WAL and enforces foreign keys', async () => {
    dir = await mkdtemp(join(tmpdir(), 'holtkeeper-sqlite-'))
    const store = sqliteStore({ path: join(dir, 'store.db') })
    const outcome = await store.users
      .putPasskey({ id: 'pk', userId: 'nobody', publicKey: 'k', counter: 0, createdAt: 'now' })
      .then(
        () => 'saved',
        () => 'rejected',
      )
    expect(outcome).toBe('rejected')
    await store.close()
    const db = new Database(join(dir, 'store.db'), { readonly: true })
    expect(db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode).toBe(
      'wal',
    )
    db.close()
  })
})
