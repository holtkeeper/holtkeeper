import type { Database, SQLQueryBindings } from 'bun:sqlite'

import type { AuditEvent, AuditFilter, AuditStore } from '@holtkeeper/store'
import {
  AUDIT_EXPORT_BATCH,
  auditCursorSeq,
  auditVerifyRange,
  sealAuditEvent,
  verifyAuditEvents,
} from '@holtkeeper/store'

interface EventRow {
  event: string
}

interface ChainRow {
  head_seq: number
  head_hash: string
  swept_through: number
}

const toEvent = (row: EventRow): AuditEvent => JSON.parse(row.event)

function where(filter: AuditFilter, extra: string[] = [], extraParams: SQLQueryBindings[] = []) {
  const clauses = [...extra]
  const params: SQLQueryBindings[] = [...extraParams]
  const add = (clause: string, value: SQLQueryBindings | undefined) => {
    if (value === undefined) return
    clauses.push(clause)
    params.push(value)
  }
  add('actor_id = ?', filter.actor)
  if (filter.action !== undefined) {
    clauses.push('substr(action, 1, ?) = ?')
    params.push(filter.action.length, filter.action)
  }
  add('target_type = ?', filter.targetType)
  add('target_id = ?', filter.targetId)
  add('target_repo = ?', filter.repo)
  add('outcome = ?', filter.outcome)
  add('via = ?', filter.via)
  add('at >= ?', filter.from)
  add('at < ?', filter.to)
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

/**
 * The SQLite `AuditStore`. Each event is kept whole as JSON next to indexed filter columns; the
 * chain head and the sweep watermark live in `audit_chain`, so appends from several connections
 * serialize on an immediate transaction and `seq` is never reused after a sweep.
 */
export function sqliteAudit(db: Database): AuditStore {
  const chain = db.query<ChainRow, []>('SELECT * FROM audit_chain WHERE id = 1')
  const insert = db.prepare(
    `INSERT INTO audit_events (seq, id, at, actor_id, via, action, target_type, target_id, target_repo, outcome, event, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const setHead = db.prepare(
    `INSERT INTO audit_chain (id, head_seq, head_hash, swept_through) VALUES (1, ?, ?, 0)
     ON CONFLICT (id) DO UPDATE SET head_seq = excluded.head_seq, head_hash = excluded.head_hash`,
  )
  const byId = db.query<EventRow, [string]>('SELECT event FROM audit_events WHERE id = ?')

  const append = db.transaction((input: Parameters<AuditStore['append']>[0]) => {
    const head = chain.get()
    const event = sealAuditEvent(
      input,
      head ? { seq: head.head_seq, hash: head.head_hash } : undefined,
    )
    insert.run(
      event.seq,
      event.id,
      event.at,
      event.actor.id,
      event.via,
      event.action,
      event.target.type,
      event.target.id ?? null,
      event.target.repo ?? null,
      event.outcome,
      JSON.stringify(event),
      event.prevHash,
      event.hash,
    )
    setHead.run(event.seq, event.hash)
    return event
  })

  const sweep = db.transaction((before: string) => {
    const keep = db
      .query<{ seq: number | null }, [string]>(
        'SELECT min(seq) AS seq FROM audit_events WHERE at >= ?',
      )
      .get(before)?.seq
    const last = db
      .query<{ seq: number | null }, [number]>(
        'SELECT max(seq) AS seq FROM audit_events WHERE seq < ?',
      )
      .get(keep ?? Number.MAX_SAFE_INTEGER)?.seq
    if (last === null || last === undefined) return 0
    const removed = db.run('DELETE FROM audit_events WHERE seq <= ?', [last]).changes
    db.run('UPDATE audit_chain SET swept_through = ? WHERE id = 1', [last])
    return removed
  })

  return {
    append: async (input) => append.immediate(input),
    async get(id) {
      const row = byId.get(id)
      return row ? toEvent(row) : undefined
    },
    async list({ cursor, limit = 50, ...filter } = {}) {
      const before = auditCursorSeq(cursor)
      const clause = before === undefined ? where(filter) : where(filter, ['seq < ?'], [before])
      const rows = db
        .query<EventRow, SQLQueryBindings[]>(
          `SELECT event FROM audit_events ${clause.sql} ORDER BY seq DESC LIMIT ?`,
        )
        .all(...clause.params, limit + 1)
      const events = rows.slice(0, limit).map(toEvent)
      const last = events.at(-1)
      return {
        events,
        ...(rows.length > limit && last && { nextCursor: String(last.seq) }),
      }
    },
    async count(filter = {}) {
      const clause = where(filter)
      return (
        db
          .query<{ n: number }, SQLQueryBindings[]>(
            `SELECT count(*) AS n FROM audit_events ${clause.sql}`,
          )
          .get(...clause.params)?.n ?? 0
      )
    },
    async *export(filter = {}) {
      let after = 0
      for (;;) {
        const clause = where(filter, ['seq > ?'], [after])
        const rows = db
          .query<EventRow, SQLQueryBindings[]>(
            `SELECT event FROM audit_events ${clause.sql} ORDER BY seq LIMIT ?`,
          )
          .all(...clause.params, AUDIT_EXPORT_BATCH)
        for (const row of rows) {
          const event = toEvent(row)
          after = event.seq
          yield event
        }
        if (rows.length < AUDIT_EXPORT_BATCH) return
      }
    },
    sweep: async (before) => sweep.immediate(before),
    async verifyChain(requested = {}) {
      const head = chain.get()
      const range = auditVerifyRange(requested, {
        headSeq: head?.head_seq ?? 0,
        sweptThrough: head?.swept_through ?? 0,
      })
      const query = db.query<EventRow, [number, number, number]>(
        'SELECT event FROM audit_events WHERE seq >= ? AND seq <= ? ORDER BY seq LIMIT ?',
      )
      async function* events() {
        let from = range.from
        for (;;) {
          const rows = query.all(from, range.to, AUDIT_EXPORT_BATCH)
          for (const row of rows) {
            const event = toEvent(row)
            from = event.seq + 1
            yield event
          }
          if (rows.length < AUDIT_EXPORT_BATCH) return
        }
      }
      return verifyAuditEvents(events(), range)
    },
  }
}
