import type {
  DatabaseConnections,
  DatabaseIndex,
  DatabaseInspector,
  DatabaseMigration,
  DatabaseQueryStat,
  DatabaseReplica,
  DatabaseSession,
  DatabaseTable,
} from '@holtkeeper/store'

import { type PgTimestamp, iso } from './rows.ts'
import type { Db } from './tables.ts'

const isoOr = (value: PgTimestamp | null) => (value === null ? undefined : iso(value))

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const sortColumn = { total: 'total_exec_time', mean: 'mean_exec_time', calls: 'calls' } as const

/** Schema `pg_stat_statements` is installed in, when it is. */
async function statementsSchema({ sql }: Db): Promise<string | undefined> {
  const [row]: { schema: string }[] = await sql`
    SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'pg_stat_statements'`
  return row?.schema
}

/**
 * Introspection of the Postgres database a store lives in, from the statistics views. Statement
 * statistics need the `pg_stat_statements` extension; other users' statements and replication
 * lag need the `pg_read_all_stats` role, without which they read as hidden or missing.
 */
export function postgresDatabase(db: () => Promise<Db>, schema: string): DatabaseInspector {
  return {
    engine: 'postgres',
    async overview() {
      const { sql } = await db()
      const [info]: {
        version: string
        bytes: number
        started_at: PgTimestamp
        standby: boolean
        hit: number
        read: number
        commits: number
        rollbacks: number
        deadlocks: number
        stats_reset: PgTimestamp | null
        max: number
      }[] = await sql`
        SELECT current_setting('server_version') AS version,
          pg_database_size(current_database())::float8 AS bytes,
          pg_postmaster_start_time() AS started_at, pg_is_in_recovery() AS standby,
          d.blks_hit::float8 AS hit, d.blks_read::float8 AS read,
          d.xact_commit::float8 AS commits, d.xact_rollback::float8 AS rollbacks,
          d.deadlocks::float8 AS deadlocks, d.stats_reset,
          current_setting('max_connections')::int AS max
        FROM pg_stat_database d WHERE d.datname = current_database()`
      if (!info) throw new Error('current database not found in pg_stat_database')
      const states: { state: string | null; waiting: boolean; count: number }[] = await sql`
        SELECT state, wait_event_type = 'Lock' AS waiting, count(*)::int AS count
        FROM pg_stat_activity WHERE backend_type = 'client backend'
        GROUP BY state, wait_event_type = 'Lock'`
      const connections: DatabaseConnections = {
        active: 0,
        idle: 0,
        idleInTransaction: 0,
        waiting: 0,
        total: 0,
        max: info.max,
      }
      for (const row of states) {
        connections.total += row.count
        if (row.waiting) connections.waiting += row.count
        if (row.state === 'active') connections.active += row.count
        else if (row.state === 'idle') connections.idle += row.count
        else if (row.state?.startsWith('idle in transaction'))
          connections.idleInTransaction += row.count
      }
      let replicas: DatabaseReplica[] | undefined
      if (!info.standby) {
        try {
          const rows: {
            name: string
            state: string | null
            sync: string | null
            lag: number | null
            replay: number | null
          }[] = await sql`
            SELECT application_name AS name, state, sync_state AS sync,
              pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)::float8 AS lag,
              extract(epoch FROM replay_lag)::float8 AS replay
            FROM pg_stat_replication ORDER BY application_name`
          replicas = rows.map((row) => ({
            name: row.name,
            state: row.state ?? 'unknown',
            sync: row.sync ?? 'unknown',
            ...(row.lag !== null && { lagBytes: row.lag }),
            ...(row.replay !== null && { replayLagSeconds: row.replay }),
          }))
        } catch {
          replicas = undefined
        }
      }
      const blocks = info.hit + info.read
      const statsResetAt = isoOr(info.stats_reset)
      return {
        engine: 'postgres',
        version: `PostgreSQL ${info.version}`,
        bytes: info.bytes,
        startedAt: iso(info.started_at),
        ...(blocks > 0 && { cacheHitRatio: info.hit / blocks }),
        commits: info.commits,
        rollbacks: info.rollbacks,
        deadlocks: info.deadlocks,
        ...(statsResetAt && { statsResetAt }),
        connections,
        standby: info.standby,
        ...(replicas && { replicas }),
      }
    },
    async tables() {
      const { sql } = await db()
      const rows: {
        name: string
        estimate: number
        live: number | null
        dead: number | null
        data: number
        indexes: number
        total: number
        vacuum: PgTimestamp | null
        analyze: PgTimestamp | null
        seq: number | null
        idx: number | null
      }[] = await sql`
        SELECT c.relname AS name, c.reltuples::float8 AS estimate,
          s.n_live_tup::float8 AS live, s.n_dead_tup::float8 AS dead,
          pg_relation_size(c.oid)::float8 AS data, pg_indexes_size(c.oid)::float8 AS indexes,
          pg_total_relation_size(c.oid)::float8 AS total,
          greatest(s.last_vacuum, s.last_autovacuum) AS vacuum,
          greatest(s.last_analyze, s.last_autoanalyze) AS analyze,
          s.seq_scan::float8 AS seq, s.idx_scan::float8 AS idx
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
        WHERE n.nspname = ${schema} AND c.relkind IN ('r', 'p')
        ORDER BY total DESC, c.relname`
      return rows.map((row): DatabaseTable => {
        const lastVacuumAt = isoOr(row.vacuum)
        const lastAnalyzeAt = isoOr(row.analyze)
        return {
          name: row.name,
          rows: Math.max(0, row.estimate >= 0 ? row.estimate : (row.live ?? 0)),
          dataBytes: row.data,
          indexBytes: row.indexes,
          toastBytes: Math.max(0, row.total - row.data - row.indexes),
          totalBytes: row.total,
          ...(row.dead !== null && { deadRows: row.dead }),
          ...(lastVacuumAt && { lastVacuumAt }),
          ...(lastAnalyzeAt && { lastAnalyzeAt }),
          ...(row.seq !== null && { seqScans: row.seq }),
          ...(row.idx !== null && { indexScans: row.idx }),
        }
      })
    },
    async indexes() {
      const { sql } = await db()
      const rows: {
        name: string
        table: string
        bytes: number
        scans: number | null
        definition: string
        unique: boolean
        primary: boolean
      }[] = await sql`
        SELECT i.relname AS name, t.relname AS table, pg_relation_size(i.oid)::float8 AS bytes,
          s.idx_scan::float8 AS scans, pg_get_indexdef(i.oid) AS definition,
          x.indisunique AS unique, x.indisprimary AS primary
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_class t ON t.oid = x.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        LEFT JOIN pg_stat_all_indexes s ON s.indexrelid = x.indexrelid
        WHERE n.nspname = ${schema}
        ORDER BY bytes DESC, i.relname`
      return rows.map((row): DatabaseIndex => ({
        name: row.name,
        table: row.table,
        bytes: row.bytes,
        ...(row.scans !== null && { scans: row.scans }),
        definition: row.definition,
        unique: row.unique,
        primary: row.primary,
      }))
    },
    async queries({ sort = 'total', limit = 50 } = {}) {
      const handle = await db()
      const extension = await statementsSchema(handle)
      if (!extension)
        return { available: false, reason: 'the pg_stat_statements extension is not installed' }
      const { sql } = handle
      const view = sql(`${extension}.pg_stat_statements`)
      try {
        const rows: {
          id: string
          query: string
          calls: number
          total: number
          mean: number
          max: number
          rows: number
          hit: number
          read: number
        }[] = await sql`
          SELECT queryid::text AS id, query, calls::float8 AS calls,
            total_exec_time AS total, mean_exec_time AS mean, max_exec_time AS max,
            rows::float8 AS rows, shared_blks_hit::float8 AS hit, shared_blks_read::float8 AS read
          FROM ${view}
          WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
          ORDER BY ${sql(sortColumn[sort])} DESC LIMIT ${limit}`
        let resetAt: string | undefined
        try {
          const [info]: { reset: PgTimestamp | null }[] = await sql`
            SELECT stats_reset AS reset FROM ${sql(`${extension}.pg_stat_statements_info`)}`
          resetAt = isoOr(info?.reset ?? null)
        } catch {
          resetAt = undefined
        }
        const queries = rows.map((row): DatabaseQueryStat => {
          const blocks = row.hit + row.read
          return {
            id: row.id ?? '',
            query: row.query ?? '',
            calls: row.calls,
            totalMs: row.total,
            meanMs: row.mean,
            maxMs: row.max,
            rows: row.rows,
            ...(blocks > 0 && { cacheHitRatio: row.hit / blocks }),
          }
        })
        const [grant]: { allowed: boolean | null }[] = await sql`
          SELECT bool_or(has_function_privilege(p.oid, 'EXECUTE')) AS allowed
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.proname = 'pg_stat_statements_reset' AND n.nspname = ${extension}`
        return {
          available: true,
          queries,
          ...(resetAt && { resetAt }),
          resettable: grant?.allowed ?? false,
        }
      } catch (error) {
        return { available: false, reason: message(error) }
      }
    },
    async resetQueries() {
      const handle = await db()
      const extension = await statementsSchema(handle)
      if (!extension) throw new Error('the pg_stat_statements extension is not installed')
      await handle.sql.unsafe(
        `SELECT "${extension.replaceAll('"', '""')}".pg_stat_statements_reset()`,
      )
    },
    async sessions() {
      const { sql } = await db()
      const rows: {
        pid: number
        user: string | null
        application: string | null
        client: string | null
        state: string | null
        query: string | null
        connected: PgTimestamp | null
        transaction: PgTimestamp | null
        started: PgTimestamp | null
        wait_type: string | null
        wait_event: string | null
        blocked_by: number[] | null
      }[] = await sql`
        SELECT pid, usename AS user, application_name AS application, client_addr::text AS client,
          state, left(query, 1000) AS query, backend_start AS connected, xact_start AS transaction,
          query_start AS started, wait_event_type AS wait_type, wait_event,
          array_to_json(pg_blocking_pids(pid)) AS blocked_by
        FROM pg_stat_activity
        WHERE datname = current_database() AND backend_type = 'client backend'
          AND pid <> pg_backend_pid()
        ORDER BY (state = 'active') DESC, query_start NULLS LAST, pid`
      return rows.map((row): DatabaseSession => {
        const connectedAt = isoOr(row.connected)
        const transactionStartedAt = isoOr(row.transaction)
        const queryStartedAt = isoOr(row.started)
        return {
          pid: row.pid,
          ...(row.user && { user: row.user }),
          ...(row.application && { application: row.application }),
          ...(row.client && { client: row.client }),
          state: row.state ?? 'unknown',
          ...(row.query && { query: row.query }),
          ...(connectedAt && { connectedAt }),
          ...(transactionStartedAt && { transactionStartedAt }),
          ...(queryStartedAt && { queryStartedAt }),
          ...(row.wait_type &&
            row.wait_type !== 'Client' &&
            row.wait_type !== 'Activity' && {
              waitingFor: row.wait_event ? `${row.wait_type}:${row.wait_event}` : row.wait_type,
            }),
          blockedBy: row.blocked_by ?? [],
        }
      })
    },
    async migrations() {
      const { sql } = await db()
      const rows: { version: number; applied_at: PgTimestamp }[] = await sql`
        SELECT version, applied_at FROM ${sql(`${schema}.schema_migrations`)} ORDER BY version`
      return rows.map((row): DatabaseMigration => ({
        version: row.version,
        appliedAt: iso(row.applied_at),
      }))
    },
  }
}
