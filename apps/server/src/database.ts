import type {
  DatabaseAdvice,
  DatabaseDomainView,
  DatabaseHistoryPoint,
  DatabaseIndexView,
} from '@holtkeeper/api'
import { formatBytes } from '@holtkeeper/report'
import type {
  DatabaseDomain,
  DatabaseIndex,
  DatabaseInspector,
  DatabaseOverview,
  DatabaseQueries,
  DatabaseTable,
  KvStore,
  Store,
} from '@holtkeeper/store'
import { databaseDomains, tableDomain } from '@holtkeeper/store'
import { z } from 'zod'

const HISTORY_KEY = 'database:history'
const KEEP_DAYS = 90
const MB = 1024 * 1024
const DAY_MS = 86_400_000

const historySchema = z.object({
  days: z.array(
    z.object({
      day: z.string(),
      bytes: z.number(),
      domains: z.record(z.string(), z.number()),
    }),
  ),
})

const percent = (ratio: number) => `${(ratio * 100).toFixed(ratio < 0.995 ? 1 : 2)}%`

/** `CREATE INDEX` without the index name, so indexes on the same columns compare equal. */
const shape = (definition: string) =>
  definition.replace(
    /^CREATE\s+(UNIQUE\s+)?INDEX\s+(IF NOT EXISTS\s+)?("[^"]+"|\S+)\s+ON\s+/i,
    '$1ON ',
  )

/** Indexes with `unused` and `duplicateOf` set; the larger or later of a pair is the duplicate. */
export function annotateIndexes(indexes: readonly DatabaseIndex[]): DatabaseIndexView[] {
  const first = new Map<string, string>()
  const ordered = indexes.toSorted(
    (a, b) =>
      Number(b.primary) - Number(a.primary) ||
      Number(b.unique) - Number(a.unique) ||
      a.bytes - b.bytes ||
      a.name.localeCompare(b.name),
  )
  const duplicateOf = new Map<string, string>()
  for (const index of ordered) {
    const key = `${index.table}\n${shape(index.definition)}`
    const earlier = first.get(key)
    if (earlier) duplicateOf.set(index.name, earlier)
    else first.set(key, index.name)
  }
  return indexes.map((index) => {
    const duplicate = duplicateOf.get(index.name)
    return {
      ...index,
      unused: index.scans === 0 && !index.unique && !index.primary,
      ...(duplicate && { duplicateOf: duplicate }),
    }
  })
}

/** Tables, rows and bytes per domain, with the size about a week ago from `history`. */
export function domainTotals(
  tables: readonly DatabaseTable[],
  history: readonly DatabaseHistoryPoint[] = [],
  now: Date = new Date(),
): DatabaseDomainView[] {
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS).toISOString().slice(0, 10)
  const past = history.filter((point) => point.day <= weekAgo).at(-1)
  return databaseDomains
    .map((domain): DatabaseDomainView => {
      const mine = tables.filter((table) => tableDomain(table.name) === domain)
      const before = past?.domains[domain]
      return {
        domain,
        tables: mine.length,
        rows: Math.round(mine.reduce((sum, table) => sum + table.rows, 0)),
        bytes: mine.reduce((sum, table) => sum + table.totalBytes, 0),
        ...(before !== undefined && { weekAgoBytes: before }),
      }
    })
    .filter((view) => view.tables > 0)
    .toSorted((a, b) => b.bytes - a.bytes)
}

/** Inputs of `databaseAdvice`; `queries` only when statement statistics were read. */
export interface AdviceInput {
  overview: DatabaseOverview
  tables: readonly DatabaseTable[]
  indexes: readonly DatabaseIndexView[]
  queries?: DatabaseQueries
  now?: Date
}

/**
 * Findings worth a look, warnings first: unused or duplicate indexes, dead rows, tables never
 * analyzed, sequential scans on large tables, connection pressure, a cold cache, replica lag,
 * reclaimable SQLite pages, and missing statement statistics on Postgres.
 */
export function databaseAdvice({
  overview,
  tables,
  indexes,
  queries,
  now = new Date(),
}: AdviceInput): DatabaseAdvice[] {
  const advice: DatabaseAdvice[] = []
  const add = (entry: DatabaseAdvice) => advice.push(entry)

  for (const index of indexes) {
    if (index.duplicateOf)
      add({
        kind: 'duplicate-index',
        severity: 'warning',
        subject: index.name,
        message: `Covers the same columns of ${index.table} as ${index.duplicateOf}; dropping it saves ${formatBytes(index.bytes)}`,
      })
    else if (index.unused && index.bytes >= MB)
      add({
        kind: 'unused-index',
        severity: 'warning',
        subject: index.name,
        message: `Never scanned since statistics were reset, yet takes ${formatBytes(index.bytes)} and slows writes to ${index.table}`,
      })
  }

  for (const table of tables) {
    const dead = table.deadRows ?? 0
    const share = dead / Math.max(1, dead + table.rows)
    if (dead >= 1000 && share >= 0.2)
      add({
        kind: 'dead-rows',
        severity: 'warning',
        subject: table.name,
        message: `${percent(share)} of rows are dead (${Math.round(dead).toLocaleString('en')}); ${table.lastVacuumAt ? `last vacuumed ${table.lastVacuumAt.slice(0, 10)}` : 'never vacuumed'}`,
      })
    if (
      overview.engine === 'postgres' &&
      table.rows >= 10_000 &&
      (!table.lastAnalyzeAt || now.getTime() - Date.parse(table.lastAnalyzeAt) > 30 * DAY_MS)
    )
      add({
        kind: 'stale-analyze',
        severity: 'info',
        subject: table.name,
        message: table.lastAnalyzeAt
          ? `Planner statistics are from ${table.lastAnalyzeAt.slice(0, 10)}`
          : 'Planner statistics were never collected',
      })
    const seq = table.seqScans ?? 0
    if (table.rows >= 10_000 && seq >= 1000 && seq > 10 * (table.indexScans ?? 0))
      add({
        kind: 'seq-scans',
        severity: 'info',
        subject: table.name,
        message: `${Math.round(seq).toLocaleString('en')} sequential scans over ${Math.round(table.rows).toLocaleString('en')} rows against ${Math.round(table.indexScans ?? 0).toLocaleString('en')} index scans; a query may lack an index`,
      })
  }

  const connections = overview.connections
  if (connections && connections.max > 0 && connections.total / connections.max >= 0.8)
    add({
      kind: 'connections',
      severity: 'warning',
      subject: 'database',
      message: `${connections.total} of ${connections.max} connections in use`,
    })
  if (connections?.idleInTransaction)
    add({
      kind: 'idle-in-transaction',
      severity: 'info',
      subject: 'database',
      message: `${connections.idleInTransaction} ${connections.idleInTransaction === 1 ? 'session holds' : 'sessions hold'} a transaction open while idle, which blocks vacuum`,
    })
  if (overview.cacheHitRatio !== undefined && overview.cacheHitRatio < 0.95)
    add({
      kind: 'cache',
      severity: 'warning',
      subject: 'database',
      message: `Only ${percent(overview.cacheHitRatio)} of block reads hit the cache; shared_buffers may be too small`,
    })
  for (const replica of overview.replicas ?? []) {
    const lagging = (replica.lagBytes ?? 0) >= 16 * MB || (replica.replayLagSeconds ?? 0) >= 30
    if (lagging || replica.state !== 'streaming')
      add({
        kind: 'replication',
        severity: 'warning',
        subject: replica.name,
        message:
          replica.state !== 'streaming'
            ? `Replica is ${replica.state}`
            : `Replica is ${formatBytes(replica.lagBytes ?? 0)} / ${Math.round(replica.replayLagSeconds ?? 0)} s behind`,
      })
  }
  if (
    overview.freeBytes !== undefined &&
    overview.freeBytes >= 10 * MB &&
    overview.freeBytes >= overview.bytes / 4
  )
    add({
      kind: 'free-space',
      severity: 'info',
      subject: 'database',
      message: `${formatBytes(overview.freeBytes)} of the file is free pages; VACUUM would return them to the disk`,
    })
  if (overview.engine === 'postgres' && queries && !queries.available)
    add({
      kind: 'statements',
      severity: 'info',
      subject: 'database',
      message: `Statement statistics are off: ${queries.reason}`,
    })

  return advice.toSorted(
    (a, b) => Number(b.severity === 'warning') - Number(a.severity === 'warning'),
  )
}

/** Recorded daily snapshots, oldest first; empty without any. */
export async function databaseHistory(
  kv: Pick<KvStore, 'get'> | undefined,
): Promise<DatabaseHistoryPoint[]> {
  if (!kv) return []
  const days = historySchema.safeParse(await kv.get(HISTORY_KEY)).data?.days ?? []
  return days.map((point) => ({
    ...point,
    domains: point.domains as DatabaseHistoryPoint['domains'],
  }))
}

/**
 * Measures the database now and records it as today's snapshot (replacing an earlier one of the
 * same UTC day), keeping the last 90 days.
 */
export async function recordDatabaseSnapshot(
  kv: Pick<KvStore, 'get' | 'set'>,
  inspector: DatabaseInspector,
  now: Date = new Date(),
): Promise<DatabaseHistoryPoint> {
  const [overview, tables] = await Promise.all([inspector.overview(), inspector.tables()])
  const domains: Partial<Record<DatabaseDomain, number>> = {}
  for (const table of tables) {
    const domain = tableDomain(table.name)
    domains[domain] = (domains[domain] ?? 0) + table.totalBytes
  }
  const point: DatabaseHistoryPoint = {
    day: now.toISOString().slice(0, 10),
    bytes: overview.bytes,
    domains,
  }
  const oldest = new Date(now.getTime() - KEEP_DAYS * DAY_MS).toISOString().slice(0, 10)
  const days = (await databaseHistory(kv)).filter(
    (entry) => entry.day !== point.day && entry.day > oldest,
  )
  await kv.set(HISTORY_KEY, {
    days: [...days, point].toSorted((a, b) => a.day.localeCompare(b.day)),
  })
  return point
}

/**
 * Leader duty: records a database snapshot at once and every `intervalMs` (default 6 hours), so
 * each day keeps its latest measurement. Does nothing for stores without an inspector or `kv`.
 */
export function startDatabaseSnapshots(
  store: Pick<Store, 'database' | 'kv'>,
  options: { intervalMs?: number; now?: () => Date; log?: (line: string) => void } = {},
): () => void {
  const { database, kv } = store
  if (!database || !kv) return () => {}
  const now = options.now ?? (() => new Date())
  const snapshot = async () => {
    try {
      await recordDatabaseSnapshot(kv, database, now())
    } catch (error) {
      options.log?.(
        `database: snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  void snapshot()
  const timer = setInterval(() => void snapshot(), options.intervalMs ?? 6 * 3_600_000)
  return () => clearInterval(timer)
}
