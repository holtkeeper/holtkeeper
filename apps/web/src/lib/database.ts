import type {
  DatabaseDomain,
  DatabaseHistoryPoint,
  DatabaseSession,
  DatabaseTable,
} from '@holtkeeper/api'

const domainLabels: Record<DatabaseDomain, string> = {
  jobs: 'Jobs and CI',
  analyses: 'Analyses and audits',
  audit: 'Audit log and activity',
  ai: 'AI usage',
  knowledge: 'Knowledge base',
  libraries: 'Library index',
  config: 'Config and credentials',
  accounts: 'Users and accounts',
  other: 'Other',
}

/** Human name of a table domain. */
export const domainLabel = (domain: DatabaseDomain): string => domainLabels[domain]

/** Share of dead rows among all rows of a table, 0..1; 0 without statistics. */
export function deadShare(table: Pick<DatabaseTable, 'rows' | 'deadRows'>): number {
  const dead = table.deadRows ?? 0
  return dead > 0 ? dead / (dead + table.rows) : 0
}

/** `99.2%`, two decimals above 99.5% so a cache at 99.97% does not read as 100%. */
export const formatPercent = (ratio: number): string =>
  `${(ratio * 100).toFixed(ratio >= 0.995 && ratio < 1 ? 2 : 1)}%`

/** Statement time: `0.42 ms` below a millisecond, `850 ms`, `12.4 s`, `3 min 5 s`. */
export function formatQueryMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1) return `${ms.toFixed(2)} ms`
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`
}

/** `12,345`; estimates arrive as floats. */
export const formatCount = (value: number): string => Math.round(value).toLocaleString('en')

export type TableSort = 'size' | 'rows' | 'dead'

/** Tables matching `search` (substring of the name), ordered by `sort`, largest first. */
export function sortTables<T extends DatabaseTable>(
  tables: readonly T[],
  sort: TableSort,
  search = '',
): T[] {
  const needle = search.trim().toLowerCase()
  const key = (table: T) =>
    sort === 'rows' ? table.rows : sort === 'dead' ? deadShare(table) : table.totalBytes
  return tables
    .filter((table) => !needle || table.name.toLowerCase().includes(needle))
    .toSorted((a, b) => key(b) - key(a) || a.name.localeCompare(b.name))
}

/**
 * Milliseconds the session has been in its current state of interest: the running statement for
 * active sessions, the open transaction for idle ones that hold it; undefined otherwise.
 */
export function sessionAge(session: DatabaseSession, now: Date = new Date()): number | undefined {
  const since =
    session.state === 'active'
      ? session.queryStartedAt
      : session.state.startsWith('idle in transaction')
        ? session.transactionStartedAt
        : undefined
  return since ? Math.max(0, now.getTime() - Date.parse(since)) : undefined
}

export type SessionFilter = 'busy' | 'all'

/** Sessions to show: all, or only those not plainly idle; longest-running first. */
export function filterSessions(
  sessions: readonly DatabaseSession[],
  filter: SessionFilter,
  now: Date = new Date(),
): DatabaseSession[] {
  return sessions
    .filter((session) => filter === 'all' || session.state !== 'idle')
    .toSorted((a, b) => (sessionAge(b, now) ?? -1) - (sessionAge(a, now) ?? -1) || a.pid - b.pid)
}

/** Bytes gained since the snapshot closest to `days` ago; undefined without one. */
export function growthSince(
  history: readonly DatabaseHistoryPoint[],
  bytes: number,
  days = 7,
  now: Date = new Date(),
): number | undefined {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10)
  const past = history.filter((point) => point.day <= cutoff).at(-1)
  return past ? bytes - past.bytes : undefined
}
