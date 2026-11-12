import type { ReleaseCard } from '@holtkeeper/api'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowDownWideNarrow, Plus, RefreshCw, Rocket } from 'lucide-react'
import { useState } from 'react'

import { useReleaseActions, useReleaseOverview, useRepos } from '../../api/queries.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import { foldScope } from '../../lib/home-scope.ts'
import {
  type OverviewCounts,
  type OverviewSortKey,
  type OverviewState,
  type QueueFilter,
  actionFirst,
  environmentColumns,
  environmentStatus,
  environmentTicks,
  filterOverview,
  nextStep,
  overviewCounts,
  overviewSortValue,
  overviewState,
  overviewStateOrder,
  overviewStates,
  overviewTag,
  queueCounts,
  queueFilters,
  queueRows,
  targetPipeline,
  withEnvironments,
} from '../../lib/release-overview.ts'
import { countLabel } from '../../lib/releases.ts'
import { repoKey } from '../../lib/repo.ts'
import { pageSettingKeys } from '../../lib/settings-sections.ts'
import { type SortState, sortRows } from '../../lib/table-sort.ts'
import {
  Button,
  Count,
  Dot,
  EmptyState,
  ErrorState,
  FilterButton,
  type FleetColumn,
  FleetTable,
  type LegendItem,
  LinkButton,
  Notice,
  Page,
  Placeholder,
  Segmented,
  Select,
  Strip,
  type StripCell,
  Tag,
  TickStrip,
} from '../../ui/index.ts'
import { RepoLink } from '../repos/RepoLink.tsx'
import { useConfigure } from '../settings/SettingsSheet.tsx'
import { useScope } from '../shell/scope.ts'
import { BumpTag } from './parts.tsx'
import { QueueCard } from './QueueCard.tsx'

type Row = ReleaseCard & { groups: string[] }

const queueLabels: Record<QueueFilter, string> = {
  action: 'Needs action',
  acceptance: overviewStates.acceptance.label,
  'ready-to-tag': overviewStates['ready-to-tag'].label,
  proposed: overviewStates.proposed.label,
  'deploy-failed': overviewStates['deploy-failed'].label,
}

const legend: readonly LegendItem[] = [
  { tone: 'success', label: 'Deployed' },
  { tone: 'warning', label: 'Ready' },
  { tone: 'info', label: 'Running' },
  { tone: 'danger', label: 'Failed' },
  { tone: 'none', label: 'Waiting, no job' },
]

function stripCells(
  counts: OverviewCounts,
  overview: { readAt: string; refreshing: boolean; dryRun: boolean },
): StripCell[] {
  const states: [number, string, NonNullable<StripCell['tone']>][] = [
    [counts.acceptance, 'waiting for acceptance', 'warning'],
    [counts.proposed, 'release MR open', 'info'],
    [counts.deploying, 'deploying', 'info'],
    [counts.deployFailed, 'deploy failed', 'danger'],
    [counts.unread, 'forge not read', 'danger'],
  ]
  return [
    {
      value: counts.repos,
      label: counts.repos === 1 ? 'repository releases here' : 'repositories release here',
    },
    { value: counts.needsAction, label: 'need action', tone: 'warning' },
    ...states
      .filter(([value]) => value > 0)
      .map(([value, label, tone]) => ({ value, label, tone })),
    {
      value: `${counts.unreleased}${counts.unreleasedCapped ? '+' : ''}`,
      label: 'unreleased commits',
    },
    {
      value: overview.dryRun ? 'Dry run' : 'Live',
      label: overview.dryRun ? 'steps change nothing' : 'steps change the forges',
      end: true,
    },
    {
      prefix: 'Read from the forges',
      value: formatRelative(overview.readAt),
      label: '',
      ...(overview.refreshing ? { caption: '· reading again…' } : {}),
    },
  ]
}

function NextStepCell({ row }: { row: Row }) {
  const step = nextStep(row)
  if (step.to === 'integrations')
    return (
      <LinkButton
        to="/settings/$section"
        params={{ section: 'integrations' }}
        size="sm"
        variant="secondary"
      >
        {step.label}
      </LinkButton>
    )
  const search = { repo: repoKey(row.repo) }
  return step.action ? (
    <LinkButton to="/releases/timeline" search={search} size="sm" variant="secondary">
      {step.label}
    </LinkButton>
  ) : (
    <Link
      to="/releases/timeline"
      search={search}
      className="text-xs text-muted hover:text-foreground hover:underline"
    >
      {step.label}
    </Link>
  )
}

function columnsFor(rows: readonly Row[]): FleetColumn<Row, OverviewSortKey>[] {
  const environments = environmentColumns(rows)
  const envColumns: FleetColumn<Row, OverviewSortKey>[] = environments.ticks
    ? [
        {
          id: 'environments',
          header: `Environments (${environments.names.length})`,
          className: 'min-w-32',
          cell: (row) => {
            const ticks = environmentTicks(row, environments.names)
            return (
              <TickStrip
                ticks={ticks}
                aria-label={ticks.map((tick) => tick.label).join(', ')}
                className="w-28"
              />
            )
          },
        },
      ]
    : environments.names.map((name) => ({
        id: `env:${name}`,
        header: <span className="mono">{name}</span>,
        cell: (row) => {
          const env = row.environments.find((candidate) => candidate.name === name)
          if (!env) return <span className="text-dim">—</span>
          const status = environmentStatus[env.status]
          return (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <Dot tone={status.tone} />
              {status.label}
              {env.version ? <span className="mono text-dim">{env.version}</span> : null}
            </span>
          )
        },
      }))
  return [
    {
      id: 'repo',
      header: 'Repository',
      sortKey: 'repo',
      className: 'min-w-52',
      cell: (row) => <RepoLink repo={row.repo} to="/releases/timeline" />,
    },
    {
      id: 'stage',
      header: 'Stage',
      sortKey: 'stage',
      cell: (row) => {
        const tag = overviewTag(row)
        return (
          <Tag tone={tag.tone} dot {...(row.error ? { title: row.error } : {})}>
            {tag.label}
          </Tag>
        )
      },
    },
    {
      id: 'latest',
      header: 'Latest',
      sortKey: 'latest',
      className: 'whitespace-nowrap',
      cell: (row) =>
        row.latest ? (
          <>
            <span className="mono">{row.latest.version}</span>
            {row.latest.date ? (
              <span className="ms-1.5 text-xs text-dim" title={formatDateTime(row.latest.date)}>
                {formatRelative(row.latest.date)}
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-dim">none yet</span>
        ),
    },
    {
      id: 'next',
      header: 'Next',
      sortKey: 'next',
      className: 'whitespace-nowrap',
      cell: (row) =>
        row.next ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="mono">{row.next}</span>
            <BumpTag bump={row.bump} />
          </span>
        ) : (
          <span className="text-dim">—</span>
        ),
    },
    {
      id: 'unreleased',
      header: 'Unreleased',
      sortKey: 'unreleased',
      className: 'whitespace-nowrap',
      cell: (row) =>
        row.error ? (
          <span className="text-dim">—</span>
        ) : row.unreleased ? (
          <span className="text-muted">
            {countLabel(row.unreleased, row.unreleasedCapped)} on{' '}
            <span className="mono">{row.target}</span>
            {row.tasks ? ` · ${row.tasks} ${row.tasks === 1 ? 'task' : 'tasks'}` : null}
          </span>
        ) : (
          <span className="text-dim">Everything is released</span>
        ),
    },
    {
      id: 'ci',
      header: 'CI on target',
      sortKey: 'ci',
      cell: (row) => {
        const pipeline = targetPipeline(row)
        return (
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <Dot tone={pipeline.tone} />
            {pipeline.label}
          </span>
        )
      },
    },
    ...envColumns,
    {
      id: 'step',
      header: 'Next step',
      cell: (row) => <NextStepCell row={row} />,
    },
  ]
}

/**
 * Releases › Overview: a strip of counts by state over the repositories in scope, the queue of
 * repositories that need a person as `QueueCard`s, and every repository with releases on in a
 * sortable `FleetTable` with one column per environment (a tick strip beyond three). Rows open
 * the repository's timeline; repositories the viewer may set up but that are not listed link to
 * the setup page.
 */
export function ReleasesPage() {
  const overview = useReleaseOverview()
  const repos = useRepos()
  const actions = useReleaseActions()
  const { view, setView, homeGroups } = useScope()
  const settings = useConfigure('Release settings', pageSettingKeys.releases)
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [stages, setStages] = useState<OverviewState[]>([])
  const [environments, setEnvironments] = useState<string[]>([])
  const [sort, setSort] = useState<SortState<OverviewSortKey>>(null)
  const [chosenQueue, setQueue] = useState<QueueFilter>('action')

  const groupsOf = new Map(
    (repos.data?.repos ?? []).map((summary) => [repoKey(summary.repo), summary.groups]),
  )
  const cards: Row[] = (overview.data?.cards ?? []).map((card) => ({
    ...card,
    groups: groupsOf.get(repoKey(card.repo)) ?? [],
  }))
  const inScope = foldScope(cards, view, homeGroups, (card) => card.groups).shown
  const counts = queueCounts(inScope)
  const queueFilter = counts[chosenQueue] ? chosenQueue : 'action'
  const queue = queueRows(inScope, queueFilter)

  const environmentNames = environmentColumns(cards).names
  const filtered = withEnvironments(filterOverview(cards, query), environments).filter(
    (row) => !stages.length || stages.includes(overviewState(row)),
  )
  const filtering = query !== '' || stages.length > 0 || environments.length > 0
  const rows = sortRows(actionFirst(filtered), sort, overviewSortValue)
  const columns = columnsFor(cards)
  const presentStates = new Set(cards.map(overviewState))

  const listed = new Set(cards.map((card) => repoKey(card.repo)))
  const unlisted = (repos.data?.repos ?? [])
    .filter((summary) => summary.configurable)
    .map((summary) => repoKey(summary.repo))
    .filter((key) => !listed.has(key))
    .toSorted()
  const setUp = (key: string) => void navigate({ to: '/releases/setup', search: { repo: key } })

  return (
    <Page
      crumbs={[{ label: 'Overview' }]}
      search={{
        value: query,
        onChange: setQuery,
        'aria-label': 'Filter repositories',
        placeholder: 'Filter by repository or version',
      }}
      configure={settings.configure}
      more={[
        {
          label: 'Read the forges again',
          icon: RefreshCw,
          onAction: () => actions.refresh.mutate(),
          isDisabled: actions.refresh.isPending || overview.data?.refreshing === true,
        },
      ]}
      {...(unlisted[0]
        ? {
            primary: {
              label: 'Set up releases',
              icon: Plus,
              link: { to: '/releases/setup', search: { repo: unlisted[0] } },
            },
          }
        : {})}
    >
      {overview.data?.dryRun ? (
        <Notice tone="warning" title="Dry run">
          The server runs with dryRun: steps report what they would do and change nothing.
        </Notice>
      ) : null}
      {overview.isPending ? (
        <>
          <Placeholder className="h-48" />
          <Placeholder className="h-64" />
        </>
      ) : overview.isError ? (
        <ErrorState error={overview.error} />
      ) : (
        <>
          <section
            aria-label="Release queue"
            className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-panel"
          >
            <Strip cells={stripCells(overviewCounts(inScope), overview.data)} />
            <div className="flex flex-col gap-3 p-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[13px] font-semibold">Queue</h2>
                <Segmented
                  aria-label="Queue filter"
                  options={queueFilters
                    .filter((id) => id === 'action' || counts[id] > 0)
                    .map((id) => ({
                      id,
                      label: (
                        <span className="inline-flex items-center gap-1.5">
                          {queueLabels[id]}
                          <Count>{counts[id]}</Count>
                        </span>
                      ),
                    }))}
                  value={queueFilter}
                  onChange={setQueue}
                />
                {queue.some((card) => card.can.accept) ? (
                  <span className="ms-auto text-xs text-muted">
                    Accepting records your name. You can withdraw until the tag exists.
                  </span>
                ) : null}
              </div>
              {queue.length ? (
                <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
                  {queue.map((card) => (
                    <QueueCard key={repoKey(card.repo)} card={card} />
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted">
                  Nothing waits for you: no version waits, no release merge request is open and no
                  deploy failed.
                </p>
              )}
            </div>
          </section>
          <FleetTable<Row, OverviewSortKey>
            label="All repositories"
            rows={rows}
            rowKey={(row) => repoKey(row.repo)}
            columns={columns}
            sort={sort}
            onSort={setSort}
            scope={{ value: view, onChange: setView, homeGroups }}
            legend={legend}
            toolbar={
              <>
                <FilterButton
                  label="Stage"
                  all="All"
                  options={overviewStateOrder
                    .filter((state) => presentStates.has(state))
                    .map((state) => ({ id: state, label: overviewStates[state].label }))}
                  value={stages}
                  onChange={(ids) =>
                    setStages(overviewStateOrder.filter((state) => ids.includes(state)))
                  }
                />
                {environmentNames.length ? (
                  <FilterButton
                    label="Environment"
                    all="All"
                    options={environmentNames.map((name) => ({ id: name, label: name }))}
                    value={environments}
                    onChange={(ids) =>
                      setEnvironments(environmentNames.filter((name) => ids.includes(name)))
                    }
                  />
                ) : null}
                {sort ? (
                  <Button variant="ghost" size="sm" onPress={() => setSort(null)}>
                    <ArrowDownWideNarrow className="size-3.5" />
                    Needs action first
                  </Button>
                ) : null}
              </>
            }
            onOpen={(row) =>
              void navigate({ to: '/releases/timeline', search: { repo: repoKey(row.repo) } })
            }
            othersSummary={(others) =>
              `${others.filter((row) => row.needsAction).length} need action`
            }
            caption="· rows open the repository timeline"
            empty={
              <EmptyState
                icon={<Rocket />}
                title={filtering ? 'No repository matches' : 'No repositories'}
                description={
                  filtering
                    ? 'Clear the search or a filter to see more repositories.'
                    : 'Set up releases for a repository to see it here.'
                }
              />
            }
          />
          {unlisted.length ? (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel px-3.5 py-2.5 text-xs">
              <span className="text-muted">Not set up yet</span>
              <span className="mono text-foreground">{unlisted[0]}</span>
              {unlisted.length > 1 ? (
                <span className="text-dim">and {unlisted.length - 1} more you can configure</span>
              ) : null}
              <span className="flex-1" />
              {unlisted.length > 1 ? (
                <Select
                  aria-label="Set up releases for a repository"
                  placeholder="Pick a repository…"
                  className="w-56"
                  options={unlisted.map((key) => ({
                    id: key,
                    label: <span className="mono text-xs">{key}</span>,
                    text: key,
                  }))}
                  value={undefined}
                  onChange={setUp}
                />
              ) : null}
              <LinkButton
                to="/releases/setup"
                search={{ repo: unlisted[0] }}
                size="sm"
                variant="secondary"
              >
                Set up {unlisted[0]}
              </LinkButton>
            </div>
          ) : null}
        </>
      )}
      {settings.sheet}
    </Page>
  )
}
