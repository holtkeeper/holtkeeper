import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { FlaskConical } from 'lucide-react'

import { useCoverageOverview, useRepos, useSettings } from '../../api/queries.ts'
import {
  type CoverageKpis,
  type CoverageRow,
  type CoverageSearch,
  type CoverageSortKey,
  belowTarget,
  coverageFreshness,
  coverageFreshnessLabel,
  coverageFreshnessStates,
  coverageKpis,
  coverageRows,
  coverageSort,
  coverageSortValue,
  coverageTone,
  filterCoverageRows,
  formatPercent,
  formatPoints,
  lineSegments,
  orgCoverageTarget,
  percentOf,
  pointsTone,
  trendValues,
  withCoverageSort,
} from '../../lib/coverage.ts'
import { formatDateTime, formatRelative, shortSha } from '../../lib/format.ts'
import { freshnessTone } from '../../lib/freshness.ts'
import { foldOtherTeams } from '../../lib/home-scope.ts'
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
  SegmentBar,
  type StripCell,
  Tag,
} from '../../ui/index.ts'
import { MiniSparkline } from '../../ui/MiniSparkline.tsx'
import { useRunJob } from '../jobs/RunJobDialog.tsx'
import { RepoAvatar } from '../repos/RepoAvatar.tsx'
import { useConfigure } from '../settings/SettingsSheet.tsx'
import { useScope } from '../shell/scope.ts'
import { CoverageSheet } from './CoverageSheet.tsx'

function kpiCells(kpis: CoverageKpis, target: number): StripCell[] {
  return [
    { value: formatPercent(kpis.medianLines), prefix: 'Median', label: 'lines' },
    { value: formatPercent(kpis.medianBranches), prefix: 'Median', label: 'branches' },
    {
      value: kpis.below,
      label: kpis.below === 1 ? 'repository' : 'repositories',
      prefix: `Below ${formatPercent(target)} target`,
      tone: kpis.below ? 'warning' : 'none',
      caption: '· groups and repositories may set their own',
    },
    { value: kpis.untested.toLocaleString('en'), label: 'untested files' },
    { value: kpis.freshness.current, label: 'current', tone: 'success', end: true },
    { value: kpis.freshness.behind, label: 'behind HEAD', tone: 'info' },
    { value: kpis.freshness.aging, label: 'over a week', tone: 'warning' },
    { value: kpis.freshness.stale, label: 'over a month', tone: 'danger' },
    { value: kpis.freshness.never, label: 'not measured', tone: 'none' },
  ]
}

function RepoName({ row }: { row: CoverageRow }) {
  const { namespace, name } = splitRepoPath(row.repo.path)
  return (
    <div className="flex items-start gap-2.5">
      <RepoAvatar repo={row.repo} size="sm" />
      <div className="min-w-0 leading-tight">
        <Link
          to="/repos/$"
          params={{ _splat: repoSplat(row.repo) }}
          search={{ tab: 'quality', section: 'coverage' }}
          className="mono block truncate hover:underline"
          title={row.repo.path}
        >
          <span className="text-muted">{namespace}</span>
          <span className="font-medium">{name}</span>
        </Link>
        <span className="mono text-[11px] text-dim">
          {[...row.groups, row.repo.forge].join(' · ')}
        </span>
      </div>
    </div>
  )
}

const dash = <span className="text-dim">—</span>

function columns(target: number): FleetColumn<CoverageRow, CoverageSortKey>[] {
  return [
    {
      id: 'repo',
      header: 'Repository',
      sortKey: 'repo',
      className: 'min-w-56',
      cell: (row) => <RepoName row={row} />,
    },
    {
      id: 'lines',
      header: 'Lines',
      sortKey: 'lines',
      className: 'min-w-36',
      cell: (row) => {
        const { card } = row
        if (!card) return dash
        const lines = percentOf(card.totals.lines)
        return (
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-2">
              <span className="mono tabular" style={{ color: statusColor[coverageTone(lines)] }}>
                {formatPercent(lines)}
              </span>
              {belowTarget(row, target) ? (
                <Tag tone="warning">Below {formatPercent(card.target ?? target)} target</Tag>
              ) : null}
            </span>
            <SegmentBar segments={lineSegments(card.totals)} />
          </div>
        )
      },
    },
    {
      id: 'branches',
      header: 'Branches',
      sortKey: 'branches',
      align: 'right',
      cell: ({ card }) => {
        const branches = percentOf(card?.totals.branches)
        return branches === undefined ? (
          dash
        ) : (
          <span className="mono tabular">{formatPercent(branches)}</span>
        )
      },
    },
    {
      id: 'trend',
      header: 'Last 12 records',
      cell: ({ card }) =>
        card && card.trend.length > 1 ? (
          <MiniSparkline
            values={trendValues(card)}
            color="var(--info)"
            label={`Line coverage of the last ${card.trend.length} records`}
            className="h-6 w-24"
          />
        ) : (
          dash
        ),
    },
    {
      id: 'change',
      header: 'Change',
      sortKey: 'change',
      align: 'right',
      cell: ({ card }) =>
        !card || card.change === undefined ? (
          dash
        ) : (
          <span className="mono tabular" style={{ color: statusColor[pointsTone(card.change)] }}>
            {formatPoints(card.change) || '0 pt'}
          </span>
        ),
    },
    {
      id: 'untested',
      header: 'Untested files',
      sortKey: 'untested',
      align: 'right',
      cell: ({ card }) =>
        card ? (
          <span className="tabular">
            {card.totals.untested}
            <span className="text-dim"> of {card.totals.files}</span>
          </span>
        ) : (
          dash
        ),
    },
    {
      id: 'freshness',
      header: 'Freshness',
      sortKey: 'freshness',
      className: 'whitespace-nowrap',
      cell: (row) => {
        const state = coverageFreshness(row)
        return (
          <div className="flex flex-col gap-0.5 leading-tight">
            <Tag tone={freshnessTone[state]} dot>
              {coverageFreshnessLabel[state]}
            </Tag>
            <span
              className="text-[11px] text-dim"
              {...(row.card ? { title: formatDateTime(row.card.createdAt) } : {})}
            >
              {row.card ? (
                <>
                  {formatRelative(row.card.createdAt)}
                  {row.card.sha ? <span className="mono"> · {shortSha(row.card.sha)}</span> : null}
                </>
              ) : (
                'No coverage record yet'
              )}
            </span>
          </div>
        )
      },
    },
  ]
}

/**
 * Quality › Coverage: every readable repository as a fleet table row, measured ones by their
 * newest coverage record (lowest line coverage first), the rest as "Not measured". A KPI strip
 * sums the rows in scope against the coverage target; filters and sort live in the URL, and a row
 * opens `CoverageSheet` (`?repo=`).
 */
export function CoveragePage() {
  const overview = useCoverageOverview()
  const repos = useRepos()
  const settingsList = useSettings()
  const search = useSearch({ from: '/app/quality/coverage' })
  const navigate = useNavigate({ from: '/quality/coverage' })
  const setSearch = (next: CoverageSearch) => void navigate({ search: next, replace: true })
  const { view, setView, homeGroups } = useScope()
  const settings = useConfigure('Coverage settings', pageSettingKeys.coverage)
  const run = useRunJob({ analyzer: 'coverage', label: 'Run coverage' })

  const target = orgCoverageTarget(settingsList.data)
  const all = coverageRows(overview.data?.repos ?? [], repos.data?.repos ?? [])
  const sort = coverageSort(search)
  const rows = sortRows(filterCoverageRows(all, search, target), sort, (row, key) =>
    coverageSortValue(row, key),
  )
  const groups = [...new Set(all.flatMap((row) => row.groups))].toSorted()
  const filtered = Boolean(
    search.q || search.group?.length || search.freshness?.length || search.below,
  )

  const folded = foldOtherTeams(rows, homeGroups, (row) => row.groups)
  const order = view === 'mine' ? [...folded.mine, ...folded.others] : rows
  const selected = parseRepoKey(search.repo)
  const index = selected ? order.findIndex((row) => repoKey(row.repo) === repoKey(selected)) : -1
  const open = (row: CoverageRow | undefined) =>
    setSearch(row ? { ...search, repo: repoKey(row.repo) } : { ...search, repo: undefined })
  const previous = index > 0 ? order[index - 1] : undefined
  const next = index >= 0 ? order[index + 1] : undefined

  return (
    <Page
      crumbs={[{ label: 'Coverage' }]}
      description="Newest coverage record of each repository · lowest first"
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
        <FleetTable<CoverageRow, CoverageSortKey>
          label="Coverage by repository"
          rows={rows}
          rowKey={(row) => repoKey(row.repo)}
          columns={columns(target)}
          sort={sort}
          onSort={(nextSort) => setSearch(withCoverageSort(search, nextSort))}
          scope={{ value: view, onChange: setView, homeGroups }}
          strip={(shown) => kpiCells(coverageKpis(shown, target), target)}
          legend={[
            { tone: 'success', label: 'Covered' },
            { tone: 'warning', label: 'Uncovered' },
            { tone: 'danger', label: 'In files without tests' },
          ]}
          toolbar={
            <>
              <FilterButton
                label="Group"
                options={groups.map((id) => ({ id, label: id }))}
                value={search.group ?? []}
                onChange={(group) =>
                  setSearch({ ...search, group: group.length ? group : undefined })
                }
              />
              <FilterButton
                label="Freshness"
                options={coverageFreshnessStates.map((id) => ({
                  id,
                  label: coverageFreshnessLabel[id],
                }))}
                value={search.freshness ?? []}
                onChange={(freshness) =>
                  setSearch({
                    ...search,
                    freshness: freshness.length
                      ? coverageFreshnessStates.filter((state) => freshness.includes(state))
                      : undefined,
                  })
                }
              />
              <Checkbox
                label={`Below ${formatPercent(target)} only`}
                isSelected={search.below === true}
                onChange={(below) => setSearch({ ...search, below: below ? true : undefined })}
              />
              {sort ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() => setSearch(withCoverageSort(search, null))}
                >
                  Sort: lowest first
                </Button>
              ) : null}
            </>
          }
          onOpen={open}
          othersSummary={(others) => {
            const kpis = coverageKpis(others, target)
            return `Median ${formatPercent(kpis.medianLines)} lines · ${kpis.below} below target`
          }}
          caption={`· target ${formatPercent(target)} lines unless a group or repository sets its own`}
          empty={
            <EmptyState
              icon={<FlaskConical />}
              title={filtered ? 'No repository matches' : 'No repositories'}
              description={
                filtered
                  ? 'Clear a filter to see more repositories.'
                  : 'Repositories show up here once they belong to a configured group.'
              }
            />
          }
        />
      )}
      <CoverageSheet
        repo={selected}
        target={target}
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
