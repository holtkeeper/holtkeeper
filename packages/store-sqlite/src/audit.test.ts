import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AuditEventInput } from '@holtkeeper/store'

import { migrate, migrations } from './migrations.ts'
import { sqliteStore } from './sqlite.ts'

const input = (minute: number): AuditEventInput => ({
  at: `2026-10-30T09:${String(minute).padStart(2, '0')}:00.000Z`,
  actor: { id: 'alice', name: 'Alice', provider: 'users' },
  via: 'api',
  action: 'setting.update',
  target: { type: 'setting', id: 's1' },
  outcome: 'ok',
})

describe('sqlite audit log', () => {
  let dir: string | undefined
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  test('detects events edited or deleted behind the store, and seq survives reopening', async () => {
    dir = await mkdtemp(join(tmpdir(), 'holtkeeper-audit-'))
    const path = join(dir, 'store.db')
    const store = sqliteStore({ path })
    for (const minute of [1, 2, 3, 4]) await store.audit?.append(input(minute))
    expect(await store.audit?.verifyChain()).toMatchObject({ ok: true, checked: 4 })
    await store.close()

    const db = new Database(path)
    const row = db
      .query<{ event: string }, []>('SELECT event FROM audit_events WHERE seq = 2')
      .get()
    const forged = { ...JSON.parse(row?.event ?? '{}'), action: 'setting.read' }
    db.run('UPDATE audit_events SET event = ? WHERE seq = 2', [JSON.stringify(forged)])
    db.close()

    const reopened = sqliteStore({ path })
    expect((await reopened.audit?.verifyChain())?.broken).toMatchObject({ seq: 2, reason: 'hash' })
    expect(await reopened.audit?.verifyChain({ fromSeq: 3 })).toMatchObject({ ok: true })
    const next = await reopened.audit?.append(input(5))
    expect(next?.seq).toBe(5)
    await reopened.close()

    const raw = new Database(path)
    raw.run('DELETE FROM audit_events WHERE seq = 5')
    raw.close()
    const truncated = sqliteStore({ path })
    expect((await truncated.audit?.verifyChain({ fromSeq: 3 }))?.broken).toMatchObject({
      reason: 'tail',
    })
    await truncated.close()
  })

  test('export pages through more events than one batch', async () => {
    const store = sqliteStore({ path: ':memory:' })
    for (let i = 0; i < 1203; i++) await store.audit?.append(input(i % 60))
    let count = 0
    let last = 0
    for await (const event of store.audit?.export() ?? []) {
      expect(event.seq).toBe(last + 1)
      last = event.seq
      count++
    }
    expect(count).toBe(1203)
    expect(await store.audit?.verifyChain()).toMatchObject({ ok: true, checked: 1203 })
    await store.close()
  })

  test('v8 adds avatar seeds to existing users', () => {
    const db = new Database(':memory:')
    migrate(
      db,
      migrations.filter((m) => m.version < 8),
    )
    db.run(
      `INSERT INTO users (id, name, grants, disabled, session_version, created_at)
       VALUES ('u1', 'U', '[]', 0, 1, 'now')`,
    )
    migrate(db)
    const user = db
      .query<{ avatar_seed: string | null }, []>("SELECT avatar_seed FROM users WHERE id = 'u1'")
      .get()
    expect(user?.avatar_seed).toBeNull()
    db.close()
  })
})
