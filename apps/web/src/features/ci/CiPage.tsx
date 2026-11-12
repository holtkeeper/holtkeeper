import type { CiRepoCard } from '@holtkeeper/api'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { Timer } from 'lucide-react'

import { useCiOverview, useGroupTitles } from '../../api/queries.ts'
import {
  type CiKpis,
  type CiSearch,
  type CiSortKey,
  changeLabel,
  ciKpis,
  ciSort,
  ciSortValue,
  ciStatusLabel,
  ciStatusTone,
  ciStatuses,
  filterCiCards,
  parseCiSearch,
  seconds,
  successTone,
  withCiSort,
  worstCiFirst,
} from '../../lib/ci.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import { foldScope } from '../../lib/home-scope.ts'
import { parseRepoKey, repoKey, repoSplat, splitRepoPath } from '../../lib/repo.ts'
import { pageSettingKeys } from '../../lib/settings-sections.ts'
import { sortRows } from '../../lib/table-sort.ts'
import { statusColor } from '../../ui/colors.ts'
import {
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  type FleetColumn,
  FilterButton,
  FleetTable,
  Page,
  Placeholder,
  type StripCell,
  Tag,
} from '../../ui/index.ts'
import { MiniSparkline } from '../../ui/MiniSparkline.tsx'
import { useRunJob } from '../jobs/RunJobDialog.tsx'
import { RepoAvatar } from '../repos/RepoAvatar.tsx'
import { useConfigure } from '../settings/SettingsSheet.tsx'
import { useScope } from '../shell/scope.ts'
import { CiFleetJobs } from './CiFleetJobs.tsx'
import { CiSheet } from './CiSheet.tsx'

function kpiCells(kpis: CiKpis): StripCell[] {
  return [
    {
      value: kpis.repos,
      label: kpis.repos === 1 ? 'repository ran CI in 30 days' : 'repositories ran CI in 30 days',
    },
    { prefix: 'Median pipeline', value: seconds(kpis.median), label: '' },
    { prefix: 'p90', value: seconds(kpis.p90), label: '' },
    {
      prefix: 'Success',
      value: kpis.successRate === undefined ? '—' : `${kpis.successRate}%`,
      label: '',
    },
    { prefix: 'Flaky jobs', value: kpis.flakyJobs, label: '' },
    { prefix: 'Queue p50', value: seconds(kpis.queueMedian), label: '' },
    { value: kpis.statuses.failing, label: 'failing', tone: 'danger', end: true },
    { value: kpis.statuses.flaky, label: 'flaky', tone: 'warning' },
    { value: kpis.statuses.slower, label: 'slower', tone: 'warning' },
    { value: kpis.statuses.healthy, label: 'healthy', tone: 'success' },
    ...(kpis.statuses.idle
      ? [{ value: kpis.statuses.idle, label: 'idle', tone: 'none' as const }]
      : []),
  ]
}

function RepoName({ card }: { card: CiRepoCard }) {
  const { namespace, name } = splitRepoPath(card.repo.path)
  return (
    <div className="flex items-start gap-2.5">
      <RepoAvatar repo={card.repo} size="sm" />
      <div className="min-w-0 leading-tight">
        <Link
          to="/repos/$"
          params={{ _splat: repoSplat(card.repo) }}
          search={{ tab: 'quality', section: 'ci' }}
          className="mono block truncate hover:underline"
          title={card.repo.path}
        >
          <span className="text-muted">{namespace}</span>
          <span className="font-medium">{name}</span>
        </Link>
        <span className="mono text-[11px] text-dim">
          {[...card.groups, card.ref].filter(Boolean).join(' · ')}
        </span>
      </div>
    </div>
  )
}

const columns: readonly FleetColumn<CiRepoCard, CiSortKey>[] = [
  {
    id: 'repo',
    header: 'Repository',
    sortKey: 'repo',
    className: 'min-w-56',
    cell: (card) => <RepoName card={card} />,
  },
  {
    id: 'status',
    header: 'Status',
    sortKey: 'status',
    cell: (card) => (
      <Tag tone={ciStatusTone[card.status]} dot>
        {ciStatusLabel[card.status]}
      </Tag>
    ),
  },
  {
    id: 'median',
    header: 'Median',
    sortKey: 'median',
    align: 'right',
    cell: (card) => <span className="mono tabular">{seconds(card.median)}</span>,
  },
  {
    id: 'change',
    header: 'Change',
    sortKey: 'change',
    align: 'right',
    cell: (card) => {
      const change = changeLabel(card.change)
      return change.text ? (
        <span
          className="mono tabular whitespace-nowrap"
          style={{ color: statusColor[change.tone] }}
          title="Last 7 days against the 7 before"
        >
          {change.text}
          {change.tone === 'danger' ? ' slower' : change.tone === 'success' ? ' faster' : ''}
        </span>
      ) : (
        <span className="text-dim">—</span>
      )
    },
  },
  {
    id: 'weeks',
    header: '8 weeks',
    cell: (card) => (
      <MiniSparkline
        values={card.weeks.slice(-8)}
        color="var(--info)"
        label={`Median pipeline time per week of ${card.repo.path}`}
        className="h-5 w-20"
      />
    ),
  },
  {
    id: 'p90',
    header: 'p90',
    sortKey: 'p90',
    align: 'right',
    cell: (card) => <span className="mono tabular text-muted">{seconds(card.p90)}</span>,
  },
  {
    id: 'success',
    header: 'Success rate',
    sortKey: 'success',
    align: 'right',
    cell: (card) =>
      card.successRate === undefined ? (
        <span className="text-dim">—</span>
      ) : (
        <span className="tabular" style={{ color: statusColor[successTone(card.successRate)] }}>
          {card.successRate}%
        </span>
      ),
  },
  {
    id: 'flaky',
    header: 'Flaky jobs',
    sortKey: 'flaky',
    align: 'right',
    cell: (card) => (
      <span className={`tabular ${card.flakyJobs ? '' : 'text-dim'}`}>{card.flakyJobs}</span>
    ),
  },
  {
    id: 'queue',
    header: 'Queue p50',
    sortKey: 'queue',
    align: 'right',
    cell: (card) => <span className="mono tabular">{seconds(card.queueMedian)}</span>,
  },
  {
    id: 'pipelines',
    header: 'Pipelines',
    sortKey: 'pipelines',
    align: 'right',
    cell: (card) => <span className="tabular">{card.pipelines}</span>,
  },
  {
    id: 'last',
    header: 'Last pipeline',
    sortKey: 'last',
    className: 'whitespace-nowrap',
    cell: (card) =>
      card.lastRunAt ? (
        <span className="text-muted" title={formatDateTime(card.lastRunAt)}>
          {formatRelative(card.lastRunAt)}
        </span>
      ) : (
        <span className="text-dim">—</span>
      ),
  },
]

/**
 * Quality › CI: every repository with CI runs in the last 30 days as a fleet table row from its
 * newest `ci-jobs` record, worst state first, with a KPI strip over the rows in scope. Filters and
 * sort live in the URL; a row opens `CiSheet` (`?repo=`).
 */
export function CiPage() {
  const overview = useCiOverview()
  const search = useSearch({ from: '/app/quality/ci' })
  const navigate = useNavigate({ from: '/quality/ci' })
  const setSearch = (next: CiSearch) => void navigate({ search: next, replace: true })
  const { view, setView, homeGroups } = useScope()
  const titleOf = useGroupTitles()
  const settings = useConfigure('CI settings', pageSettingKeys.ci)
  const run = useRunJob({ analyzer: 'ci-jobs', label: 'Run CI analysis' })

  const all = overview.data?.repos ?? []
  const sort = ciSort(search)
  const rows = sortRows(worstCiFirst(filterCiCards(all, search, titleOf)), sort, ciSortValue)
  const filtered = Boolean(search.q || search.status?.length || search.problems)

  const folded = foldScope(rows, view, homeGroups, (card) => card.groups)
  const order = [...folded.shown, ...folded.others]
  const selected = parseRepoKey(search.repo)
  const index = selected ? order.findIndex((card) => repoKey(card.repo) === repoKey(selected)) : -1
  const selectedCard = selected
    ? all.find((card) => repoKey(card.repo) === repoKey(selected))
    : undefined
  const open = (card: CiRepoCard | undefined) =>
    setSearch(card ? { ...search, repo: repoKey(card.repo) } : { ...search, repo: undefined })
  const previous = index > 0 ? order[index - 1] : undefined
  const next = index >= 0 ? order[index + 1] : undefined

  return (
    <Page
      crumbs={[{ label: 'CI' }]}
      description="Pipelines by repository · default branch · worst first"
      search={{
        value: search.q ?? '',
        onChange: (q) => setSearch({ ...search, q: q || undefined }),
        'aria-label': 'Filter repositories',
        placeholder: 'Filter by path or group',
      }}
      configure={settings.configure}
      primary={run.action}
    >
      {overview.isPending ? (
        <Placeholder className="h-64" />
      ) : overview.isError ? (
        <ErrorState error={overview.error} />
      ) : (
        <FleetTable<CiRepoCard, CiSortKey>
          label="Pipelines by repository"
          rows={rows}
          rowKey={(card) => repoKey(card.repo)}
          columns={columns}
          sort={sort}
          onSort={(nextSort) => setSearch(withCiSort(search, nextSort))}
          scope={{ value: view, onChange: setView, homeGroups }}
          strip={(shown) => kpiCells(ciKpis(shown))}
          toolbar={
            <>
              <Tag title="The CI analyzer reads the default branch">Branch: default</Tag>
              <Tag title="The CI analyzer reads the last 30 days">Last 30 days</Tag>
              <FilterButton
                label="Status"
                options={ciStatuses.map((id) => ({ id, label: ciStatusLabel[id] }))}
                value={search.status ?? []}
                onChange={(status) =>
                  setSearch({
                    ...search,
                    status: status.length ? parseCiSearch({ status }).status : undefined,
                  })
                }
              />
              <Checkbox
                label="Problems only"
                isSelected={search.problems === true}
                onChange={(problems) =>
                  setSearch({ ...search, problems: problems ? true : undefined })
                }
              />
              {sort ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() => setSearch(withCiSort(search, null))}
                >
                  Sort: worst first
                </Button>
              ) : null}
            </>
          }
          onOpen={open}
          othersSummary={(others) => {
            const kpis = ciKpis(others)
            return `${kpis.statuses.failing} failing · ${kpis.statuses.flaky} flaky · ${kpis.statuses.healthy} healthy`
          }}
          caption="· change = last 7 days against the 7 before"
          empty={
            <EmptyState
              icon={<Timer />}
              title={filtered ? 'No repository matches' : 'No CI runs'}
              description={
                filtered
                  ? 'Clear a filter to see more repositories.'
                  : 'The ci-jobs analyzer reads pipelines every night; repositories show up once they ran CI in the last 30 days.'
              }
            />
          }
        />
      )}
      {overview.data ? (
        <CiFleetJobs
          groupsOf={(key) =>
            overview.data.repos.find((card) => repoKey(card.repo) === key)?.groups ?? []
          }
          scope={{ value: view, onChange: setView, homeGroups }}
        />
      ) : null}
      <CiSheet
        repo={selected}
        card={selectedCard}
        onClose={() => open(undefined)}
        {...(index >= 0 ? { index, total: order.length } : {})}
        {...(previous ? { onPrevious: () => open(previous) } : {})}
        {...(next ? { onNext: () => open(next) } : {})}
      />
      {settings.sheet}
      {run.dialog}
    </Page>
  )
}
