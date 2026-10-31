import type {
  DatabaseAdvice,
  DatabaseQuerySort,
  DatabaseView,
  DatabaseIndexView,
} from '@holtkeeper/api'
import { formatBytes } from '@holtkeeper/api'
import { Database, RotateCcw, TriangleAlert } from 'lucide-react'
import { motion } from 'motion/react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import {
  useDatabase,
  useDatabaseQueries,
  useDatabaseSessions,
  useResetDatabaseQueries,
} from '../../api/queries.ts'
import {
  type SessionFilter,
  type TableSort,
  deadShare,
  domainLabel,
  filterSessions,
  formatCount,
  formatPercent,
  formatQueryMs,
  growthSince,
  sessionAge,
  sortTables,
} from '../../lib/database.ts'
import { formatDate, formatDateTime, formatDuration, formatRelative } from '../../lib/format.ts'
import { shareOf } from '../../lib/storage.ts'
import {
  Button,
  Chip,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Notice,
  Page,
  Panel,
  Placeholder,
  SearchInput,
  Segmented,
  Table,
  Tabs,
  Td,
  Th,
  fadeItem,
  notify,
  stagger,
} from '../../ui/index.ts'
import { Sparkline } from '../../ui/Sparkline.tsx'
import { useSession } from '../shell/session.ts'

type Loaded = Extract<DatabaseView, { available: true }>

const seriesColor = (index: number) => `var(--series-${(index % 8) + 1})`

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <motion.div
      {...fadeItem}
      className="rounded-2xl border border-border bg-surface p-4 shadow-surface"
    >
      <div className="text-sm text-muted">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight tabular">{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted">{hint}</div> : null}
    </motion.div>
  )
}

const signedBytes = (bytes: number) => `${bytes < 0 ? '−' : '+'}${formatBytes(Math.abs(bytes))}`

function Metrics({ view }: { view: Loaded }) {
  const { overview } = view
  const growth = growthSince(view.history, overview.bytes)
  const connections = overview.connections
  return (
    <motion.div {...stagger} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Metric
        label="Size"
        value={formatBytes(overview.bytes)}
        hint={
          growth !== undefined
            ? `${signedBytes(growth)} in 7 days`
            : overview.freeBytes !== undefined
              ? `${formatBytes(overview.freeBytes)} free pages`
              : 'Growth shows after a week of snapshots'
        }
      />
      {overview.cacheHitRatio !== undefined ? (
        <Metric
          label="Cache hit ratio"
          value={formatPercent(overview.cacheHitRatio)}
          hint={`${formatCount(overview.commits ?? 0)} commits · ${formatCount(overview.rollbacks ?? 0)} rollbacks${overview.deadlocks ? ` · ${formatCount(overview.deadlocks)} deadlocks` : ''}`}
        />
      ) : (
        <Metric
          label="Tables"
          value={formatCount(view.tables.length)}
          hint={`${formatCount(view.indexes.length)} indexes`}
        />
      )}
      {connections ? (
        <Metric
          label="Connections"
          value={`${connections.total} / ${connections.max}`}
          hint={`${connections.active} active · ${connections.idle} idle${connections.idleInTransaction ? ` · ${connections.idleInTransaction} idle in transaction` : ''}${connections.waiting ? ` · ${connections.waiting} waiting` : ''}`}
        />
      ) : (
        <Metric label="Rows" value={formatCount(view.tables.reduce((sum, t) => sum + t.rows, 0))} />
      )}
      {overview.startedAt ? (
        <Metric
          label="Uptime"
          value={formatRelative(overview.startedAt).replace(/ ago$/, '')}
          hint={`${overview.standby ? 'Standby' : 'Primary'} · started ${formatDateTime(overview.startedAt)}`}
        />
      ) : (
        <Metric
          label="Migrations"
          value={String(view.migrations.at(-1)?.version ?? 0)}
          hint="Latest applied version"
        />
      )}
    </motion.div>
  )
}

function AdvicePanel({ advice }: { advice: readonly DatabaseAdvice[] }) {
  if (!advice.length)
    return (
      <Notice
        tone="success"
        title="Nothing to look at: no index, vacuum or connection issues found"
      />
    )
  return (
    <Panel
      title="Worth a look"
      description={`${advice.length} ${advice.length === 1 ? 'finding' : 'findings'}`}
    >
      <ul className="flex flex-col divide-y divide-separator">
        {advice.map((entry) => (
          <li
            key={`${entry.kind}:${entry.subject}`}
            className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0"
          >
            <TriangleAlert
              className={`mt-0.5 size-4 shrink-0 ${entry.severity === 'warning' ? 'text-warning' : 'text-muted'}`}
            />
            <div className="min-w-0 text-sm">
              <span className="font-mono text-[13px]">{entry.subject}</span>{' '}
              <span className="text-muted">{entry.message}</span>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

function TablesTab({ view }: { view: Loaded }) {
  const [sort, setSort] = useState<TableSort>('size')
  const [search, setSearch] = useState('')
  const tables = sortTables(view.tables, sort, search)
  const max = Math.max(1, ...view.tables.map((table) => table.totalBytes))
  const statistics = view.overview.engine === 'postgres'
  return (
    <Panel
      title="Tables"
      description={`${view.tables.length} in the store's schema`}
      actions={
        <>
          <SearchInput
            value={search}
            onChange={setSearch}
            aria-label="Filter tables"
            placeholder="Filter"
          />
          <Segmented
            aria-label="Sort tables"
            value={sort}
            onChange={setSort}
            options={[
              { id: 'size', label: 'Size' },
              { id: 'rows', label: 'Rows' },
              ...(statistics ? [{ id: 'dead' as const, label: 'Dead rows' }] : []),
            ]}
          />
        </>
      }
    >
      <Table label="Tables">
        <thead>
          <tr>
            <Th>Table</Th>
            <Th align="right">Rows</Th>
            <Th align="right">Data</Th>
            <Th align="right">Indexes</Th>
            {statistics ? <Th align="right">TOAST</Th> : null}
            <Th align="right">Total</Th>
            {statistics ? (
              <>
                <Th align="right">Dead</Th>
                <Th>Vacuumed</Th>
                <Th>Analyzed</Th>
              </>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {tables.map((table) => {
            const dead = deadShare(table)
            return (
              <tr key={table.name}>
                <Td>
                  <div className="font-mono text-[13px]">{table.name}</div>
                  <div className="mt-1 flex items-center gap-2">
                    <div className="h-1 w-24 overflow-hidden rounded-full bg-default">
                      <div
                        className="h-full rounded-full bg-accent"
                        style={{ width: `${(table.totalBytes / max) * 100}%` }}
                      />
                    </div>
                    <span className="text-xs text-muted">{domainLabel(table.domain)}</span>
                  </div>
                </Td>
                <Td align="right" className="tabular">
                  {statistics ? '≈ ' : ''}
                  {formatCount(table.rows)}
                </Td>
                <Td align="right" className="tabular text-muted">
                  {formatBytes(table.dataBytes)}
                </Td>
                <Td align="right" className="tabular text-muted">
                  {formatBytes(table.indexBytes)}
                </Td>
                {statistics ? (
                  <Td align="right" className="tabular text-muted">
                    {formatBytes(table.toastBytes)}
                  </Td>
                ) : null}
                <Td align="right" className="tabular font-medium">
                  {formatBytes(table.totalBytes)}
                </Td>
                {statistics ? (
                  <>
                    <Td align="right" className="tabular">
                      {dead >= 0.2 && (table.deadRows ?? 0) >= 1000 ? (
                        <Chip tone="warning">{formatPercent(dead)}</Chip>
                      ) : (
                        <span className="text-muted">{formatPercent(dead)}</span>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-muted">
                      {table.lastVacuumAt ? formatRelative(table.lastVacuumAt) : 'never'}
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-muted">
                      {table.lastAnalyzeAt ? formatRelative(table.lastAnalyzeAt) : 'never'}
                    </Td>
                  </>
                ) : null}
              </tr>
            )
          })}
        </tbody>
      </Table>
    </Panel>
  )
}

function GrowthTab({ view }: { view: Loaded }) {
  const total = view.domains.reduce((sum, domain) => sum + domain.bytes, 0)
  const points = view.history.map((point) => ({
    at: `${point.day}T00:00:00.000Z`,
    value: point.bytes,
  }))
  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Database size"
        description={
          view.history.length
            ? `Daily snapshots since ${formatDate(`${view.history[0]!.day}T00:00:00.000Z`)}`
            : 'The leader records one snapshot a day; the chart fills in over time'
        }
      >
        <Sparkline
          points={points}
          label="Database size per day"
          height={140}
          format={formatBytes}
        />
      </Panel>
      <Panel
        title="By domain"
        description="What the space holds, and how it changed in the last 7 days"
      >
        <motion.ul {...stagger} className="flex flex-col gap-3">
          {view.domains.map((domain, index) => {
            const delta =
              domain.weekAgoBytes !== undefined ? domain.bytes - domain.weekAgoBytes : undefined
            return (
              <motion.li key={domain.domain} {...fadeItem} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span>
                    {domainLabel(domain.domain)}{' '}
                    <span className="text-xs text-muted">
                      {domain.tables} {domain.tables === 1 ? 'table' : 'tables'} ·{' '}
                      {formatCount(domain.rows)} rows
                    </span>
                  </span>
                  <span className="tabular shrink-0 text-xs">
                    <span className="font-medium">{formatBytes(domain.bytes)}</span>
                    {delta !== undefined && delta !== 0 ? (
                      <span className={delta > 0 ? 'text-warning' : 'text-success'}>
                        {' '}
                        {signedBytes(delta)}
                      </span>
                    ) : null}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-default">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${shareOf(domain.bytes, total)}%`,
                      background: seriesColor(index),
                    }}
                  />
                </div>
              </motion.li>
            )
          })}
        </motion.ul>
      </Panel>
    </div>
  )
}

function StatementsTab({ view, active }: { view: Loaded; active: boolean }) {
  const { can } = useSession()
  const [sort, setSort] = useState<DatabaseQuerySort>('total')
  const [confirming, setConfirming] = useState(false)
  const queries = useDatabaseQueries(sort, active && view.overview.engine === 'postgres')
  const reset = useResetDatabaseQueries()
  if (view.overview.engine !== 'postgres')
    return <EmptyState icon={<Database />} title="SQLite keeps no statement statistics" />
  if (queries.isPending) return <Placeholder className="h-64" />
  if (queries.isError) return <ErrorState error={queries.error} />
  if (!queries.data.available)
    return (
      <Notice tone="accent" title="Statement statistics are off">
        {queries.data.reason}. Load <code>pg_stat_statements</code> through{' '}
        <code>shared_preload_libraries</code> and run{' '}
        <code>CREATE EXTENSION pg_stat_statements</code> in this database; on CloudNativePG, setting
        any <code>pg_stat_statements.*</code> parameter does both. Grant the Holtkeeper user{' '}
        <code>pg_read_all_stats</code> to see statements of other users.
      </Notice>
    )
  const total = queries.data.queries.reduce((sum, query) => sum + query.totalMs, 0)
  return (
    <Panel
      title="Statements"
      description={
        queries.data.resetAt
          ? `Since ${formatDateTime(queries.data.resetAt)}`
          : 'Since statistics were last reset'
      }
      actions={
        <>
          <Segmented
            aria-label="Sort statements"
            value={sort}
            onChange={setSort}
            options={[
              { id: 'total', label: 'Total time' },
              { id: 'mean', label: 'Mean time' },
              { id: 'calls', label: 'Calls' },
            ]}
          />
          {view.resettable && can('settings:write') ? (
            <Button variant="ghost" size="sm" onPress={() => setConfirming(true)}>
              <RotateCcw className="size-3.5" />
              Reset
            </Button>
          ) : null}
        </>
      }
    >
      {queries.data.queries.length === 0 ? (
        <EmptyState title="No statements recorded yet" />
      ) : (
        <Table label="Statements">
          <thead>
            <tr>
              <Th>Statement</Th>
              <Th align="right">Calls</Th>
              <Th align="right">Total</Th>
              <Th align="right">Mean</Th>
              <Th align="right">Max</Th>
              <Th align="right">Rows</Th>
              <Th align="right">Cache</Th>
            </tr>
          </thead>
          <tbody>
            {queries.data.queries.map((query) => (
              <tr key={query.id}>
                <Td className="max-w-xl">
                  <pre
                    title={query.query}
                    className="line-clamp-3 whitespace-pre-wrap break-all font-mono text-xs"
                  >
                    {query.query}
                  </pre>
                </Td>
                <Td align="right" className="tabular">
                  {formatCount(query.calls)}
                </Td>
                <Td align="right" className="tabular whitespace-nowrap">
                  {formatQueryMs(query.totalMs)}
                  <div className="text-xs text-muted">
                    {Math.round(shareOf(query.totalMs, total))}%
                  </div>
                </Td>
                <Td align="right" className="tabular whitespace-nowrap">
                  {formatQueryMs(query.meanMs)}
                </Td>
                <Td align="right" className="tabular whitespace-nowrap text-muted">
                  {formatQueryMs(query.maxMs)}
                </Td>
                <Td align="right" className="tabular text-muted">
                  {formatCount(query.rows)}
                </Td>
                <Td align="right" className="tabular text-muted">
                  {query.cacheHitRatio !== undefined ? formatPercent(query.cacheHitRatio) : '—'}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <ConfirmDialog
        isOpen={confirming}
        onOpenChange={setConfirming}
        title="Reset statement statistics?"
        confirmLabel="Reset"
        isPending={reset.isPending}
        onConfirm={() =>
          reset.mutate(undefined, {
            onSuccess: () => {
              notify.success('Statement statistics reset')
              setConfirming(false)
            },
            onError: (error) => notify.error('Reset failed', messageOf(error)),
          })
        }
      >
        Counters start from zero for every statement in this database, including those of other
        applications.
      </ConfirmDialog>
    </Panel>
  )
}

function SessionsTab({ view, active }: { view: Loaded; active: boolean }) {
  const [filter, setFilter] = useState<SessionFilter>('busy')
  const sessions = useDatabaseSessions(active)
  const replicas = view.overview.replicas ?? []
  const now = new Date()
  const shown = filterSessions(sessions.data?.sessions ?? [], filter, now)
  return (
    <div className="flex flex-col gap-4">
      {replicas.length ? (
        <Panel title="Replicas" description="Streaming replication as the primary sees it">
          <ul className="grid gap-3 md:grid-cols-3">
            {replicas.map((replica) => (
              <li key={replica.name} className="rounded-xl bg-default p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-[13px]">{replica.name}</span>
                  <Chip tone={replica.state === 'streaming' ? 'success' : 'warning'}>
                    {replica.state}
                  </Chip>
                </div>
                <div className="mt-1 text-xs text-muted">
                  {replica.sync}
                  {replica.lagBytes !== undefined
                    ? ` · ${formatBytes(replica.lagBytes)} behind`
                    : ''}
                  {replica.replayLagSeconds !== undefined
                    ? ` · ${replica.replayLagSeconds.toFixed(1)} s replay lag`
                    : ''}
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
      <Panel
        title="Sessions"
        description="Client connections to this database, refreshed every 5 seconds"
        actions={
          <Segmented
            aria-label="Show sessions"
            value={filter}
            onChange={setFilter}
            options={[
              { id: 'busy', label: 'Busy' },
              { id: 'all', label: 'All' },
            ]}
          />
        }
      >
        {sessions.isPending ? (
          <Placeholder className="h-40" />
        ) : sessions.isError ? (
          <ErrorState error={sessions.error} />
        ) : shown.length === 0 ? (
          <EmptyState title={filter === 'busy' ? 'Every session is idle' : 'No other sessions'} />
        ) : (
          <Table label="Sessions">
            <thead>
              <tr>
                <Th>Pid</Th>
                <Th>State</Th>
                <Th>Client</Th>
                <Th align="right">For</Th>
                <Th>Waiting for</Th>
                <Th>Statement</Th>
              </tr>
            </thead>
            <tbody>
              {shown.map((session) => {
                const age = sessionAge(session, now)
                return (
                  <tr key={session.pid}>
                    <Td className="tabular">{session.pid}</Td>
                    <Td>
                      <Chip
                        tone={
                          session.blockedBy.length
                            ? 'danger'
                            : session.state === 'active'
                              ? 'accent'
                              : session.state.startsWith('idle in transaction')
                                ? 'warning'
                                : 'default'
                        }
                      >
                        {session.state}
                      </Chip>
                    </Td>
                    <Td className="text-xs">
                      <div>{session.application || session.user || '—'}</div>
                      <div className="text-muted">
                        {[session.user, session.client].filter(Boolean).join(' · ')}
                      </div>
                    </Td>
                    <Td align="right" className="tabular whitespace-nowrap">
                      {age !== undefined ? formatDuration(age) : '—'}
                    </Td>
                    <Td className="text-xs">
                      {session.waitingFor ?? '—'}
                      {session.blockedBy.length ? (
                        <div className="text-danger">blocked by {session.blockedBy.join(', ')}</div>
                      ) : null}
                    </Td>
                    <Td className="max-w-xl">
                      {session.query ? (
                        <pre
                          title={session.query}
                          className="line-clamp-2 whitespace-pre-wrap break-all font-mono text-xs"
                        >
                          {session.query}
                        </pre>
                      ) : null}
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        )}
      </Panel>
    </div>
  )
}

const flagged = (index: DatabaseIndexView) => index.unused || index.duplicateOf !== undefined

function IndexesTab({ view }: { view: Loaded }) {
  const [filter, setFilter] = useState<'flagged' | 'all'>('all')
  const indexes = view.indexes.filter((index) => filter === 'all' || flagged(index))
  const statistics = view.overview.engine === 'postgres'
  return (
    <Panel
      title="Indexes"
      description={`${view.indexes.length} indexes · ${formatBytes(view.indexes.reduce((sum, index) => sum + index.bytes, 0))}`}
      actions={
        <Segmented
          aria-label="Show indexes"
          value={filter}
          onChange={setFilter}
          options={[
            { id: 'all', label: 'All' },
            { id: 'flagged', label: `Flagged (${view.indexes.filter(flagged).length})` },
          ]}
        />
      }
    >
      {indexes.length === 0 ? (
        <EmptyState title="No unused or duplicate indexes" />
      ) : (
        <Table label="Indexes">
          <thead>
            <tr>
              <Th>Index</Th>
              <Th>Table</Th>
              <Th align="right">Size</Th>
              {statistics ? <Th align="right">Scans</Th> : null}
              <Th>Definition</Th>
            </tr>
          </thead>
          <tbody>
            {indexes.map((index) => (
              <tr key={index.name}>
                <Td>
                  <div className="font-mono text-[13px]">{index.name}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {index.primary ? (
                      <Chip>primary</Chip>
                    ) : index.unique ? (
                      <Chip>unique</Chip>
                    ) : null}
                    {index.unused ? <Chip tone="warning">unused</Chip> : null}
                    {index.duplicateOf ? (
                      <Chip tone="warning">repeats {index.duplicateOf}</Chip>
                    ) : null}
                  </div>
                </Td>
                <Td className="font-mono text-[13px] text-muted">{index.table}</Td>
                <Td align="right" className="tabular">
                  {formatBytes(index.bytes)}
                </Td>
                {statistics ? (
                  <Td align="right" className="tabular text-muted">
                    {index.scans !== undefined ? formatCount(index.scans) : '—'}
                  </Td>
                ) : null}
                <Td className="max-w-md">
                  <code className="break-all text-xs text-muted">{index.definition}</code>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  )
}

function MigrationsTab({ view }: { view: Loaded }) {
  return (
    <Panel title="Migrations" description={`${view.migrations.length} applied`}>
      <ul className="flex flex-col divide-y divide-separator text-sm">
        {view.migrations.toReversed().map((migration) => (
          <li key={migration.version} className="flex items-center justify-between gap-3 py-2">
            <span className="tabular font-medium">Version {migration.version}</span>
            <span className="text-xs text-muted">{formatDateTime(migration.appliedAt)}</span>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

/** Size, tables, growth, statements, sessions and indexes of the store's database. */
export function DatabasePage() {
  const database = useDatabase()
  const [tab, setTab] = useState('tables')
  const view = database.data

  return (
    <Page
      title="Database"
      icon="storage"
      description={
        view?.available
          ? view.overview.version
          : 'Size, tables, slow statements and health of the store'
      }
    >
      {database.isPending ? (
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((key) => (
              <Placeholder key={key} className="h-24" />
            ))}
          </div>
          <Placeholder className="h-80" />
        </div>
      ) : database.isError ? (
        <ErrorState error={database.error} />
      ) : !view?.available ? (
        <EmptyState icon={<Database />} title="No database to inspect" description={view?.reason} />
      ) : (
        <>
          <Metrics view={view} />
          <AdvicePanel advice={view.advice} />
          <Tabs
            aria-label="Database sections"
            selected={tab}
            onSelect={setTab}
            items={[
              { id: 'tables', label: 'Tables', content: <TablesTab view={view} /> },
              { id: 'growth', label: 'Growth', content: <GrowthTab view={view} /> },
              ...(view.overview.engine === 'postgres'
                ? [
                    {
                      id: 'statements',
                      label: 'Statements',
                      content: <StatementsTab view={view} active={tab === 'statements'} />,
                    },
                    {
                      id: 'sessions',
                      label: 'Sessions',
                      content: <SessionsTab view={view} active={tab === 'sessions'} />,
                    },
                  ]
                : []),
              { id: 'indexes', label: 'Indexes', content: <IndexesTab view={view} /> },
              { id: 'migrations', label: 'Migrations', content: <MigrationsTab view={view} /> },
            ]}
          />
        </>
      )}
    </Page>
  )
}
