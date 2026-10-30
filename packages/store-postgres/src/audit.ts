import type { AuditEvent, AuditFilter, AuditStore } from '@holtkeeper/store'
import {
  AUDIT_EXPORT_BATCH,
  auditCursorSeq,
  auditVerifyRange,
  sealAuditEvent,
  verifyAuditEvents,
} from '@holtkeeper/store'
import type { SQL } from 'bun'

import { num } from './rows.ts'
import type { Db, Tables } from './tables.ts'

interface AuditStateRow {
  head_seq: number | string
  head_hash: string | null
  swept_through: number | string
}

/** The `WHERE` condition of an audit filter. */
const where = (sql: SQL, f: AuditFilter) => sql`
  (${f.actor ?? null}::text IS NULL OR actor_id = ${f.actor ?? null}::text)
  AND (${f.action ?? null}::text IS NULL OR starts_with(action, ${f.action ?? null}::text))
  AND (${f.targetType ?? null}::text IS NULL OR target_type = ${f.targetType ?? null}::text)
  AND (${f.targetId ?? null}::text IS NULL OR target_id = ${f.targetId ?? null}::text)
  AND (${f.repo ?? null}::text IS NULL OR target_repo = ${f.repo ?? null}::text)
  AND (${f.outcome ?? null}::text IS NULL OR outcome = ${f.outcome ?? null}::text)
  AND (${f.via ?? null}::text IS NULL OR via = ${f.via ?? null}::text)
  AND (${f.from ?? null}::timestamptz IS NULL OR at >= ${f.from ?? null}::timestamptz)
  AND (${f.to ?? null}::timestamptz IS NULL OR at < ${f.to ?? null}::timestamptz)`

/** Matching events in `range`, oldest first, read `AUDIT_EXPORT_BATCH` at a time. */
async function* batches(
  sql: SQL,
  t: Tables,
  filter: AuditFilter,
  range: { from: number; to: number } = { from: 1, to: Number.MAX_SAFE_INTEGER },
): AsyncGenerator<AuditEvent> {
  let after = range.from - 1
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- each batch starts after the last one
    const rows: { seq: number | string; event: AuditEvent }[] = await sql`
      SELECT seq, event FROM ${t.auditEvents}
      WHERE ${where(sql, filter)} AND seq > ${after} AND seq <= ${range.to}
      ORDER BY seq LIMIT ${AUDIT_EXPORT_BATCH}`
    for (const row of rows) yield row.event
    const last = rows.at(-1)
    if (!last || rows.length < AUDIT_EXPORT_BATCH) return
    after = num(last.seq)
  }
}

/**
 * The Postgres `AuditStore`. Each event is kept whole in a `jsonb` column, so it reads back with
 * exactly the fields its hash covers (`canonicalJson` ignores key order); filters use real
 * columns. The single `audit_state` row holds the chain head and how far `sweep` went: `append`
 * and `sweep` lock it, so appends from every process form one chain.
 */
export function postgresAudit(db: () => Promise<Db>): AuditStore {
  return {
    async append(input) {
      const { sql, t } = await db()
      return sql.begin(async (tx) => {
        const [state]: AuditStateRow[] = await tx`
          SELECT head_seq, head_hash FROM ${t.auditState} FOR UPDATE`
        const headSeq = num(state?.head_seq)
        const event = sealAuditEvent(
          input,
          headSeq > 0 && state?.head_hash ? { seq: headSeq, hash: state.head_hash } : undefined,
        )
        await tx`
          INSERT INTO ${t.auditEvents} (seq, id, at, actor_id, action, target_type, target_id,
            target_repo, outcome, via, event)
          VALUES (${event.seq}, ${event.id}, ${event.at}, ${event.actor.id}, ${event.action},
            ${event.target.type}, ${event.target.id ?? null}, ${event.target.repo ?? null},
            ${event.outcome}, ${event.via}, ${tx.json(event)})`
        await tx`UPDATE ${t.auditState} SET head_seq = ${event.seq}, head_hash = ${event.hash}`
        return event
      })
    },
    async get(id) {
      const { sql, t } = await db()
      const [row]: { event: AuditEvent }[] = await sql`
        SELECT event FROM ${t.auditEvents} WHERE id = ${id}`
      return row?.event
    },
    async list({ cursor, limit = 50, ...filter } = {}) {
      const { sql, t } = await db()
      const before = auditCursorSeq(cursor) ?? null
      const rows: { seq: number | string; event: AuditEvent }[] = await sql`
        SELECT seq, event FROM ${t.auditEvents}
        WHERE ${where(sql, filter)} AND (${before}::bigint IS NULL OR seq < ${before}::bigint)
        ORDER BY seq DESC LIMIT ${limit + 1}`
      const kept = rows.slice(0, limit)
      const last = kept.at(-1)
      return {
        events: kept.map((row) => row.event),
        ...(rows.length > limit && last && { nextCursor: String(num(last.seq)) }),
      }
    },
    async count(filter = {}) {
      const { sql, t } = await db()
      const [row]: { count: number }[] = await sql`
        SELECT COUNT(*)::int AS count FROM ${t.auditEvents} WHERE ${where(sql, filter)}`
      return row?.count ?? 0
    },
    async *export(filter = {}) {
      const { sql, t } = await db()
      yield* batches(sql, t, filter)
    },
    async sweep(before) {
      const { sql, t } = await db()
      return sql.begin(async (tx) => {
        await tx`SELECT 1 FROM ${t.auditState} FOR UPDATE`
        const [removed]: { count: number; through: number | string | null }[] = await tx`
          WITH gone AS (
            DELETE FROM ${t.auditEvents}
            WHERE seq < COALESCE(
              (SELECT min(seq) FROM ${t.auditEvents} WHERE at >= ${before}::timestamptz),
              (SELECT max(seq) + 1 FROM ${t.auditEvents}))
            RETURNING seq
          )
          SELECT COUNT(*)::int AS count, max(seq) AS through FROM gone`
        if (removed?.through != null)
          await tx`UPDATE ${t.auditState} SET swept_through = GREATEST(swept_through, ${num(removed.through)})`
        return removed?.count ?? 0
      })
    },
    async verifyChain(requested = {}) {
      const { sql, t } = await db()
      const [state]: AuditStateRow[] = await sql`
        SELECT head_seq, swept_through FROM ${t.auditState}`
      const range = auditVerifyRange(requested, {
        headSeq: num(state?.head_seq),
        sweptThrough: num(state?.swept_through),
      })
      return verifyAuditEvents(batches(sql, t, {}, range), range)
    },
  }
}
