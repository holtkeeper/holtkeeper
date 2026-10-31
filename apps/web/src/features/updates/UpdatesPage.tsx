import type { DependencyUpdatesOverview, FleetUpdate, RepoUpdates } from '@holtkeeper/api'
import { Link, useSearch } from '@tanstack/react-router'
import {
  CircleAlert,
  CircleCheck,
  GitMerge,
  GitPullRequest,
  PackageCheck,
  ShieldAlert,
} from 'lucide-react'
import { motion } from 'motion/react'
import { useState } from 'react'

import { useDependencyUpdates } from '../../api/queries.ts'
import { analysisPages } from '../../lib/analyses.ts'
import { formatRelative, plural } from '../../lib/format.ts'
import { parseRepoKey, repoKey, repoName } from '../../lib/repo.ts'
import {
  type StateFilter,
  filterRepos,
  mergeRequestTone,
  orderedMergeRequests,
  reportOnly,
  sourceLabel,
  stateBreakdown,
  stateMeta,
  updateStates,
} from '../../lib/updates.ts'
import {
  Chip,
  EmptyState,
  ErrorState,
  Notice,
  Page,
  Panel,
  Placeholder,
  SearchInput,
  Segmented,
  StatCard,
  Table,
  Tabs,
  Td,
  Th,
  Tooltip,
  stagger,
  tableScrollClass,
} from '../../ui/index.ts'
import { AnalysisRecords, RepoSelect } from '../analyses/AnalysesPage.tsx'
import { RunJobButton } from '../jobs/RunJobDialog.tsx'

const page = analysisPages.find((p) => p.kind === 'renovate') ?? analysisPages[0]

const stateFilters = [
  { id: 'all', label: 'All' },
  ...updateStates.map((state) => ({ id: state, label: stateMeta[state].label })),
] as const satisfies readonly { id: StateFilter; label: string }[]

/** Update state of every repository, the dependencies the fleet lags behind on, and Renovate records. */
export function UpdatesPage() {
  const search = useSearch({ strict: false })
  const repo = parseRepoKey(typeof search.repo === 'string' ? search.repo : undefined)
  const [tab, setTab] = useState('overview')

  return (
    <Page
      title="Dependency updates"
      icon="updates"
      description={
        repo
          ? `Renovate reports of ${repoKey(repo)}`
          : 'What is updated, what waits for review and what is broken, across repositories'
      }
      actions={
        <div className="flex items-center gap-2">
          <RepoSelect to={page.to} />
          <RunJobButton
            analyzer="renovate"
            label="Run Renovate"
            variant="secondary"
            {...(repo ? { repo } : {})}
          />
        </div>
      }
    >
      {repo ? (
        <AnalysisRecords page={page} repo={repo} />
      ) : (
        <Tabs
          aria-label="Update views"
          selected={tab}
          onSelect={setTab}
          items={[
            { id: 'overview', label: 'Across repositories', content: <Overview /> },
            { id: 'records', label: 'Renovate reports', content: <AnalysisRecords page={page} /> },
          ]}
        />
      )}
    </Page>
  )
}

function Overview() {
  const overview = useDependencyUpdates()
  const [state, setState] = useState<StateFilter>('all')
  const [query, setQuery] = useState('')

  if (overview.isPending)
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
  if (overview.isError) return <ErrorState error={overview.error} />
  const data = overview.data
  if (!data.repos.length)
    return (
      <Panel>
        <EmptyState
          icon={<PackageCheck />}
          title="No update records yet"
          description="Renovate runs on weekday nights in report-only mode. Run it now to see what is outdated."
          action={<RunJobButton analyzer="renovate" label="Run Renovate" size="sm" />}
        />
      </Panel>
    )

  const { totals } = data
  const repos = filterRepos(data.repos, { state, query })
  const waiting = reportOnly(data.repos)

  return (
    <div className="flex flex-col gap-5">
      <motion.div {...stagger} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Up to date"
          value={totals.current}
          icon={<CircleCheck />}
          accent={stateMeta.current.color}
          hint={`of ${plural(totals.repos, 'repository', 'repositories')}`}
        />
        <StatCard
          label="Awaiting review"
          value={totals.openMergeRequests}
          icon={<GitPullRequest />}
          accent={stateMeta.review.color}
          hint={`Open in ${plural(totals.review, 'repository', 'repositories')}`}
        />
        <StatCard
          label="Broken"
          value={totals.broken}
          icon={<CircleAlert />}
          accent={stateMeta.broken.color}
          hint="Failed runs or failed pipelines"
        />
        <StatCard
          label="Updated in 30 days"
          value={totals.merged}
          icon={<GitMerge />}
          accent="var(--sev-low)"
          hint="Update merge requests merged"
        />
      </motion.div>

      <StateBar totals={totals} />

      {totals.security ? (
        <Notice
          tone="danger"
          title={`${plural(totals.security, 'security fix', 'security fixes')} pending`}
        >
          Dependencies with a known vulnerability have a fixed release. They are listed first under
          the dependencies below.
        </Notice>
      ) : null}
      {waiting ? (
        <Notice
          tone="accent"
          title={`Renovate only reports in ${plural(waiting, 'repository', 'repositories')}`}
        >
          Nothing proposes their updates yet. Switch the mode to merge requests for a group or a
          repository in{' '}
          <Link
            to="/settings"
            search={{ tab: 'analyzers' }}
            className="text-accent hover:underline"
          >
            Settings → Analyzers → Renovate
          </Link>
          .
        </Notice>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          aria-label="Filter repositories"
          placeholder="Filter by repository"
          value={query}
          onChange={setQuery}
          className="w-64"
        />
        <Segmented aria-label="State" options={stateFilters} value={state} onChange={setState} />
      </div>

      <Panel contentClassName="p-0">
        {repos.length ? (
          <RepoTable repos={repos} />
        ) : (
          <EmptyState
            icon={<PackageCheck />}
            title="No repository matches"
            description="Try another state or filter."
          />
        )}
      </Panel>

      {data.dependencies.length ? <FleetTable dependencies={data.dependencies} /> : null}
    </div>
  )
}

function StateBar({ totals }: { totals: DependencyUpdatesOverview['totals'] }) {
  const breakdown = stateBreakdown(totals)
  return (
    <div className="flex flex-col gap-2">
      <div
        role="img"
        aria-label={breakdown.map((b) => `${stateMeta[b.state].label}: ${b.count}`).join(', ')}
        className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-default"
      >
        {breakdown.map((entry) => (
          <motion.span
            key={entry.state}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{ background: stateMeta[entry.state].color }}
            initial={{ width: 0 }}
            animate={{ width: `${entry.share * 100}%` }}
            transition={{ type: 'spring', stiffness: 160, damping: 26 }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {breakdown.map((entry) => (
          <Tooltip key={entry.state} content={stateMeta[entry.state].hint}>
            <span tabIndex={0} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="size-2 rounded-full"
                style={{ background: stateMeta[entry.state].color }}
              />
              {stateMeta[entry.state].label}
              <span className="tabular font-medium text-foreground">{entry.count}</span>
            </span>
          </Tooltip>
        ))}
      </div>
    </div>
  )
}

function OutdatedCell({ renovate }: { renovate: NonNullable<RepoUpdates['renovate']> }) {
  const share = renovate.dependencies ? renovate.outdated / renovate.dependencies : 0
  return (
    <div className="flex min-w-36 flex-col gap-1">
      <div className="flex items-baseline gap-1 text-sm">
        <span className="tabular font-semibold">{renovate.outdated}</span>
        <span className="text-muted">of {renovate.dependencies}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-default">
        <motion.span
          className="block h-full rounded-full"
          style={{ background: renovate.majors ? 'var(--danger)' : 'var(--warning)' }}
          initial={{ width: 0 }}
          animate={{ width: `${share * 100}%` }}
        />
      </div>
    </div>
  )
}

function RepoTable({ repos }: { repos: readonly RepoUpdates[] }) {
  return (
    <div className={tableScrollClass}>
      <Table label="Repositories by update state">
        <thead>
          <tr>
            <Th>Repository</Th>
            <Th>State</Th>
            <Th>Outdated</Th>
            <Th>Needs attention</Th>
            <Th>Merge requests</Th>
            <Th>Checked</Th>
          </tr>
        </thead>
        <tbody>
          {repos.map((entry) => {
            const key = repoKey(entry.repo)
            const meta = stateMeta[entry.state]
            const renovate = entry.renovate
            return (
              <tr key={key}>
                <Td>
                  <Link
                    to="/updates"
                    search={{ repo: key }}
                    className="font-medium hover:underline"
                  >
                    {repoName(entry.repo)}
                  </Link>
                  <div className="text-xs text-muted">{entry.repo.path}</div>
                </Td>
                <Td>
                  <Tooltip content={meta.hint}>
                    <span tabIndex={0} className="inline-flex">
                      <Chip tone={meta.tone}>{meta.label}</Chip>
                    </span>
                  </Tooltip>
                </Td>
                <Td>
                  {renovate ? (
                    <OutdatedCell renovate={renovate} />
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {renovate?.status === 'failed' ? (
                      <Chip tone="danger">Renovate failed</Chip>
                    ) : null}
                    {renovate?.security ? (
                      <Chip tone="danger">
                        <ShieldAlert className="mr-1 inline size-3" />
                        {renovate.security} security
                      </Chip>
                    ) : null}
                    {renovate?.majors ? (
                      <Chip tone="warning">{plural(renovate.majors, 'major')}</Chip>
                    ) : null}
                    {renovate?.pending ? (
                      <Tooltip content="Held back until the release is old enough">
                        <span tabIndex={0} className="inline-flex">
                          <Chip>{renovate.pending} waiting</Chip>
                        </span>
                      </Tooltip>
                    ) : null}
                    {entry.browserslist?.status === 'failed' ? (
                      <Chip tone="danger">Browserslist failed</Chip>
                    ) : null}
                    {entry.propagation &&
                    (entry.propagation.status === 'failed' ||
                      entry.propagation.status === 'error') ? (
                      <Chip tone="danger">{entry.propagation.packages.join(', ')} failed</Chip>
                    ) : null}
                  </div>
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {orderedMergeRequests(entry)
                      .slice(0, 6)
                      .map((mr) => (
                        <Tooltip
                          key={`${mr.source}:${mr.id}`}
                          content={`${sourceLabel[mr.source]}: ${mr.title} (${mr.status})`}
                        >
                          <a href={mr.url} target="_blank" rel="noreferrer" className="inline-flex">
                            <Chip tone={mergeRequestTone[mr.status]} className="font-mono">
                              !{mr.id}
                            </Chip>
                          </a>
                        </Tooltip>
                      ))}
                    {entry.mergeRequests.length > 6 ? (
                      <span className="text-xs text-muted">+{entry.mergeRequests.length - 6}</span>
                    ) : null}
                    {!entry.mergeRequests.length ? <span className="text-muted">—</span> : null}
                  </div>
                </Td>
                <Td>
                  {renovate ? (
                    <Link
                      to="/analyses/$id"
                      params={{ id: renovate.analysisId }}
                      className="text-sm text-muted hover:text-foreground hover:underline"
                    >
                      {formatRelative(renovate.createdAt)}
                    </Link>
                  ) : (
                    <span className="text-sm text-muted">never</span>
                  )}
                </Td>
              </tr>
            )
          })}
        </tbody>
      </Table>
    </div>
  )
}

function FleetTable({ dependencies }: { dependencies: readonly FleetUpdate[] }) {
  return (
    <Panel
      title="Dependencies the fleet lags behind on"
      description="Updates found in the most repositories, security fixes first"
      contentClassName="p-0"
    >
      <div className={tableScrollClass}>
        <Table label="Dependencies with updates across repositories">
          <thead>
            <tr>
              <Th>Dependency</Th>
              <Th>Newest offered</Th>
              <Th>Repositories</Th>
              <Th>Major behind</Th>
            </tr>
          </thead>
          <tbody>
            {dependencies.map((dep) => (
              <tr key={`${dep.manager}:${dep.dependency}`}>
                <Td>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-medium">{dep.dependency}</span>
                    {dep.security ? <Chip tone="danger">security</Chip> : null}
                  </div>
                  <div className="text-xs text-muted">{dep.manager}</div>
                </Td>
                <Td>
                  <span className="font-mono text-sm">{dep.latest ?? '—'}</span>
                </Td>
                <Td>
                  <Tooltip content={dep.repos.join('\n')}>
                    <span tabIndex={0} className="tabular text-sm font-semibold">
                      {dep.repos.length}
                    </span>
                  </Tooltip>
                </Td>
                <Td>
                  {dep.majors ? (
                    <Chip tone="warning">in {plural(dep.majors, 'repo')}</Chip>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </Panel>
  )
}
