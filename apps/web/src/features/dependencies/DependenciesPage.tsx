import type { DependencyInventory } from '@holtkeeper/api'
import { Link, useSearch } from '@tanstack/react-router'
import { ArrowUpCircle, Boxes, ChevronRight, GitFork, Layers, Package } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'

import { useDependencies } from '../../api/queries.ts'
import { analysisPages } from '../../lib/analyses.ts'
import {
  type Lag,
  type Library,
  type LibraryFilter,
  filterLibraries,
  inventoryTotals,
  lagLabel,
  lagTone,
  matrixRow,
  versionBreakdown,
  worstLag,
} from '../../lib/dependencies.ts'
import { formatDateTime, formatRef, formatRelative, plural } from '../../lib/format.ts'
import { parseRepoKey, repoKey, repoName } from '../../lib/repo.ts'
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Page,
  Panel,
  Placeholder,
  SearchInput,
  Segmented,
  Select,
  StatCard,
  Switch,
  Table,
  Tabs,
  Td,
  Th,
  Tooltip,
  stagger,
} from '../../ui/index.ts'
import { AnalysisRecords, RepoSelect } from '../analyses/AnalysesPage.tsx'
import { RunJobButton } from '../jobs/RunJobDialog.tsx'

const page = analysisPages.find((p) => p.kind === 'depgraph') ?? analysisPages[2]
const pageSize = 60

const filters = [
  { id: 'all', label: 'All' },
  { id: 'drifting', label: 'Several versions' },
  { id: 'behind', label: 'Behind' },
  { id: 'major', label: 'Major behind' },
] as const satisfies readonly { id: LibraryFilter; label: string }[]

const views = [
  { id: 'libraries', label: 'Libraries' },
  { id: 'matrix', label: 'Matrix' },
] as const

const lags = ['none', 'patch', 'minor', 'major'] as const satisfies readonly Lag[]

const lagColor: Record<Lag, string> = {
  none: 'var(--success)',
  patch: 'var(--muted)',
  minor: 'var(--warning)',
  major: 'var(--danger)',
}

/** Libraries across every repository, which versions each one installs, and the record history. */
export function DependenciesPage() {
  const search = useSearch({ strict: false })
  const repoParam = typeof search.repo === 'string' ? search.repo : undefined
  const repo = parseRepoKey(repoParam)
  const [tab, setTab] = useState('inventory')

  return (
    <Page
      title="Dependencies"
      icon={page.icon}
      description={
        repo
          ? `Libraries of ${repoKey(repo)} compared with the other repositories`
          : 'Which libraries every repository installs, and where versions drift apart'
      }
      actions={
        <div className="flex items-center gap-2">
          <RepoSelect to={page.to} />
          <RunJobButton
            analyzer="depgraph"
            label="Run now"
            variant="secondary"
            {...(repo ? { repo } : {})}
          />
        </div>
      }
    >
      <Tabs
        aria-label="Dependency views"
        selected={tab}
        onSelect={setTab}
        items={[
          {
            id: 'inventory',
            label: 'Across repositories',
            content: <Inventory {...(repoParam && repo ? { repo: repoParam } : {})} />,
          },
          {
            id: 'records',
            label: 'Graph reports',
            content: <AnalysisRecords page={page} {...(repo ? { repo } : {})} />,
          },
        ]}
      />
    </Page>
  )
}

function Inventory({ repo }: { repo?: string }) {
  const inventory = useDependencies()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<LibraryFilter>('all')
  const [view, setView] = useState<(typeof views)[number]['id']>('libraries')
  const [includeDev, setIncludeDev] = useState(true)
  const [ecosystem, setEcosystem] = useState('*')
  const [limit, setLimit] = useState(pageSize)

  if (inventory.isPending)
    return (
      <div className="flex flex-col gap-3">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Placeholder key={i} className="h-28" />
          ))}
        </div>
        <Placeholder className="h-96" />
      </div>
    )
  if (inventory.isError) return <ErrorState error={inventory.error} />
  const data = inventory.data
  if (!data.repos.length)
    return (
      <Panel>
        <EmptyState
          icon={<Boxes />}
          title="No dependency graphs yet"
          description="Run the Dependencies analysis on a repository; its lockfile shows up here and is compared with the others."
        />
      </Panel>
    )

  const ecosystems = [...new Set(data.libraries.map((library) => library.ecosystem))].toSorted()
  const scoped = filterLibraries(data.libraries, {
    includeDev,
    ecosystem,
    ...(repo ? { repo } : {}),
  })
  const libraries = filterLibraries(scoped, { query, filter })
  const totals = inventoryTotals(scoped)
  const repoCount = repo ? 1 : data.repos.length
  const visible = libraries.slice(0, limit)
  const resetLimit =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value)
      setLimit(pageSize)
    }

  return (
    <div className="flex flex-col gap-5">
      <motion.div {...stagger} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Libraries"
          value={totals.libraries}
          icon={<Package />}
          accent="var(--accent)"
          hint={`${totals.usages} direct ${plural(totals.usages, 'dependency', 'dependencies')} in ${repoCount} ${plural(repoCount, 'repository', 'repositories')}`}
        />
        <StatCard
          label="In several versions"
          value={totals.drifting}
          icon={<GitFork />}
          accent="var(--warning)"
          hint="Repositories disagree on the version"
        />
        <StatCard
          label="Major version behind"
          value={totals.major}
          icon={<Layers />}
          accent="var(--danger)"
          hint="Libraries with a breaking upgrade pending somewhere"
        />
        <StatCard
          label="Usages behind latest"
          value={totals.behind}
          icon={<ArrowUpCircle />}
          accent="var(--sev-low)"
          hint="Latest = newest version installed anywhere in the fleet"
        />
      </motion.div>

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          aria-label="Filter libraries"
          placeholder="Filter by library"
          value={query}
          onChange={resetLimit(setQuery)}
          className="w-64"
        />
        <Segmented
          aria-label="Show"
          options={filters}
          value={filter}
          onChange={resetLimit(setFilter)}
        />
        {ecosystems.length > 1 ? (
          <Select
            aria-label="Ecosystem"
            className="w-40"
            options={[
              { id: '*', label: 'All ecosystems' },
              ...ecosystems.map((id) => ({ id, label: id })),
            ]}
            value={ecosystem}
            onChange={resetLimit(setEcosystem)}
          />
        ) : null}
        <Switch label="Dev dependencies" isSelected={includeDev} onChange={setIncludeDev} />
        <div className="ml-auto">
          <Segmented aria-label="View" options={views} value={view} onChange={setView} />
        </div>
      </div>

      <Panel contentClassName="p-0">
        {libraries.length === 0 ? (
          <EmptyState
            icon={<Package />}
            title="No library matches"
            description="Try another filter or include dev dependencies."
          />
        ) : view === 'libraries' ? (
          <LibraryList libraries={visible} repos={data.repos} />
        ) : (
          <Matrix libraries={visible} repos={data.repos} {...(repo ? { repo } : {})} />
        )}
      </Panel>

      {libraries.length > visible.length ? (
        <div className="flex justify-center">
          <Button variant="ghost" onPress={() => setLimit(limit + pageSize)}>
            Show {Math.min(pageSize, libraries.length - visible.length)} more of{' '}
            {libraries.length - visible.length}
          </Button>
        </div>
      ) : null}

      <p className="text-xs text-muted">
        Direct dependencies from the newest Dependencies record of each repository.{' '}
        {data.repos.length} {plural(data.repos.length, 'repository', 'repositories')} scanned, the
        oldest {formatRelative(data.repos.map((r) => r.createdAt).toSorted()[0] ?? '')}.
      </p>
    </div>
  )
}

function LagChip({ lag, version }: { lag: Lag; version: string }) {
  return (
    <Tooltip content={lagLabel[lag]}>
      <span tabIndex={0} className="inline-flex">
        <Chip tone={lagTone[lag]} className="font-mono">
          {version}
        </Chip>
      </span>
    </Tooltip>
  )
}

function VersionBar({ library }: { library: Library }) {
  const breakdown = versionBreakdown(library)
  const total = breakdown.reduce((sum, entry) => sum + entry.count, 0)
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div
        role="img"
        aria-label={breakdown.map((b) => `${b.version}: ${b.count}`).join(', ')}
        className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-default"
      >
        {breakdown.map((entry) => (
          <motion.span
            key={entry.version}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{ background: lagColor[entry.lag] }}
            initial={{ width: 0 }}
            animate={{ width: `${(entry.count / total) * 100}%` }}
            transition={{ type: 'spring', stiffness: 160, damping: 26 }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
        {breakdown.slice(0, 4).map((entry) => (
          <span key={entry.version} className="inline-flex items-center gap-1">
            <span
              aria-hidden
              className="size-1.5 rounded-full"
              style={{ background: lagColor[entry.lag] }}
            />
            <span className="font-mono text-foreground">{entry.version}</span>×{entry.count}
          </span>
        ))}
        {breakdown.length > 4 ? <span>+{breakdown.length - 4} more</span> : null}
      </div>
    </div>
  )
}

function LibraryList({
  libraries,
  repos,
}: {
  libraries: readonly Library[]
  repos: DependencyInventory['repos']
}) {
  const [open, setOpen] = useState<string>()
  const analysisOf = new Map(repos.map((r) => [repoKey(r.repo), r]))
  return (
    <ul className="divide-y divide-separator">
      {libraries.map((library) => {
        const id = `${library.ecosystem}:${library.name}`
        const expanded = open === id
        const repoTotal = new Set(library.usages.map((u) => u.origin)).size
        const lag = worstLag(library.usages.map((u) => u.lag))
        const source = library.source ? parseRepoKey(library.source.origin) : undefined
        return (
          <li key={id}>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setOpen(expanded ? undefined : id)}
              className="grid w-full items-center gap-x-6 gap-y-2 px-4 py-3 text-left transition-colors hover:bg-default-soft focus-visible:bg-default-soft focus-visible:outline-none md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_7rem_8rem_auto]"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-sm font-medium">{library.name}</span>
                  {library.source ? <Chip tone="accent">internal</Chip> : null}
                </div>
                <div className="text-xs text-muted">
                  {library.ecosystem} · latest <span className="font-mono">{library.latest}</span>
                  {source ? ` · from ${repoName(source)}` : ''}
                </div>
              </div>
              <VersionBar library={library} />
              <div className="text-sm">
                <span className="tabular font-semibold">{repoTotal}</span>{' '}
                <span className="text-muted">{plural(repoTotal, 'repo')}</span>
              </div>
              <div>
                {library.behind ? (
                  <Chip tone={lagTone[lag]}>
                    {library.behind} {lag} behind
                  </Chip>
                ) : (
                  <Chip tone="success">Aligned</Chip>
                )}
              </div>
              <ChevronRight
                className={`hidden size-4 text-muted transition-transform md:block ${expanded ? 'rotate-90' : ''}`}
              />
            </button>
            <AnimatePresence initial={false}>
              {expanded ? (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden"
                >
                  <div className="bg-surface-secondary px-4 pb-3 pt-1">
                    <Table label={`Usages of ${library.name}`}>
                      <thead>
                        <tr>
                          <Th>Repository</Th>
                          <Th>Workspace</Th>
                          <Th>Kind</Th>
                          <Th>Version</Th>
                          <Th>Graph</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {library.usages.map((usage) => {
                          const repo = parseRepoKey(usage.origin)
                          const record = analysisOf.get(usage.origin)
                          return (
                            <tr key={`${usage.origin}:${usage.workspace}`}>
                              <Td>
                                {repo ? (
                                  <Link
                                    to="/repos/view"
                                    search={{ repo: usage.origin }}
                                    className="font-medium hover:underline"
                                  >
                                    {repo.path}
                                  </Link>
                                ) : (
                                  usage.origin
                                )}
                              </Td>
                              <Td className="font-mono text-xs">{usage.workspace}</Td>
                              <Td className="text-muted">{usage.kind}</Td>
                              <Td>
                                <LagChip lag={usage.lag} version={usage.version} />
                              </Td>
                              <Td className="whitespace-nowrap text-xs text-muted">
                                {record ? (
                                  <Link
                                    to="/analyses/$id"
                                    params={{ id: record.analysisId }}
                                    search={{}}
                                    className="hover:underline"
                                    title={formatDateTime(record.createdAt)}
                                  >
                                    {record.ref
                                      ? formatRef(record.ref)
                                      : formatRelative(record.createdAt)}
                                  </Link>
                                ) : null}
                              </Td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </Table>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </li>
        )
      })}
    </ul>
  )
}

function Matrix({
  libraries,
  repos,
  repo,
}: {
  libraries: readonly Library[]
  repos: DependencyInventory['repos']
  repo?: string
}) {
  const used = new Set(libraries.flatMap((library) => library.usages.map((u) => u.origin)))
  const columns = repos.filter(
    (r) => used.has(repoKey(r.repo)) && (!repo || repoKey(r.repo) === repo),
  )
  return (
    <div className="max-h-[70vh] overflow-auto">
      <table
        aria-label="Versions per repository"
        className="border-separate border-spacing-0 text-sm"
      >
        <thead>
          <tr>
            <th
              scope="col"
              className="sticky left-0 top-0 z-20 border-b border-border bg-surface px-4 py-2 text-left align-bottom text-xs font-medium uppercase tracking-wide text-muted"
            >
              Library
            </th>
            <th
              scope="col"
              className="sticky top-0 z-10 border-b border-border bg-surface px-3 py-2 text-left align-bottom text-xs font-medium uppercase tracking-wide text-muted"
            >
              Latest
            </th>
            {columns.map((column) => (
              <th
                key={repoKey(column.repo)}
                scope="col"
                title={repoKey(column.repo)}
                className="sticky top-0 z-10 border-b border-border bg-surface px-2 py-2 align-bottom"
              >
                <Link
                  to="/repos/view"
                  search={{ repo: repoKey(column.repo) }}
                  className="mx-auto block max-h-40 truncate text-xs font-medium [writing-mode:vertical-rl] rotate-180 hover:underline"
                >
                  {repoName(column.repo)}
                </Link>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {libraries.map((library) => {
            const row = matrixRow(library)
            return (
              <tr key={`${library.ecosystem}:${library.name}`} className="group">
                <th
                  scope="row"
                  className="sticky left-0 z-10 max-w-64 truncate border-b border-separator bg-surface px-4 py-1.5 text-left font-mono text-xs font-medium group-hover:bg-surface-secondary"
                >
                  {library.name}
                </th>
                <td className="border-b border-separator px-3 py-1.5 font-mono text-xs text-muted group-hover:bg-surface-secondary">
                  {library.latest}
                </td>
                {columns.map((column) => {
                  const cell = row.get(repoKey(column.repo))
                  return (
                    <td
                      key={repoKey(column.repo)}
                      className="border-b border-separator px-1 py-1 text-center group-hover:bg-surface-secondary"
                    >
                      {cell ? (
                        <Tooltip
                          content={
                            <div className="flex flex-col gap-0.5 text-xs">
                              <span className="font-medium">{repoKey(column.repo)}</span>
                              {cell.versions.map((v) => (
                                <span key={v.version}>
                                  <span className="font-mono">{v.version}</span> ·{' '}
                                  {lagLabel[v.lag].toLowerCase()} · {v.workspaces.join(', ')}
                                </span>
                              ))}
                            </div>
                          }
                        >
                          <span
                            tabIndex={0}
                            className="inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 font-mono text-xs"
                            style={{
                              background: `color-mix(in oklab, ${lagColor[cell.versions[0]?.lag ?? 'none']} 16%, transparent)`,
                            }}
                          >
                            {cell.versions[0]?.version}
                            {cell.versions.length > 1 ? (
                              <span className="text-muted">+{cell.versions.length - 1}</span>
                            ) : null}
                          </span>
                        </Tooltip>
                      ) : (
                        <span className="text-muted/40">·</span>
                      )}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
      <Legend />
    </div>
  )
}

function Legend() {
  return (
    <ul className="sticky left-0 flex flex-wrap gap-x-4 gap-y-1 px-4 py-3 text-xs text-muted">
      {lags.map((lag) => (
        <li key={lag} className="flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-full" style={{ background: lagColor[lag] }} />
          {lagLabel[lag]}
        </li>
      ))}
    </ul>
  )
}
