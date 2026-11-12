import type { BranchCleanupReason, RepoRef } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { ExternalLink, GitBranch } from 'lucide-react'
import { useState } from 'react'

import { useBranchesOverview } from '../../api/queries.ts'
import {
  type BranchesSearch,
  type BranchesSortKey,
  type BranchKpis,
  type BranchListRow,
  branchAges,
  branchKpis,
  branchListRows,
  branchReasons,
  branchSortValue,
  branchesSort,
  filterBranchRepos,
  filterBranchesExceptReason,
  oldestFirst,
  reasonCounts,
  reasonLabel,
  reasonTone,
  signed,
} from '../../lib/branches.ts'
import { formatDate, plural } from '../../lib/format.ts'
import { foldOtherTeams } from '../../lib/home-scope.ts'
import { parseRepoKey, repoKey, repoSplat } from '../../lib/repo.ts'
import { selectAll, selectAllState, selectOne } from '../../lib/table-selection.ts'
import { sortRows } from '../../lib/table-sort.ts'
import {
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  type FleetColumn,
  FilterButton,
  FleetTable,
  Placeholder,
  Segmented,
  Select,
  type StripCell,
  Tag,
} from '../../ui/index.ts'
import { RunJobButton } from '../jobs/RunJobDialog.tsx'
import { useScope } from '../shell/scope.ts'
import { BranchesSheet } from './BranchesSheet.tsx'

const ageOptions = [
  { id: 'any', label: 'Age: Any' },
  ...branchAges.map((days) => ({ id: days, label: `Older than ${days} days` })),
]

const mrState = { open: 'Open', merged: 'Merged', closed: 'Closed' } as const

function kpiCells(kpi: BranchKpis): StripCell[] {
  const stale = kpi.staleDays.length === 1 ? `, no commits for ${kpi.staleDays[0]} days` : ''
  return [
    {
      value: kpi.cleanup.toLocaleString('en'),
      label: 'to clean up',
      caption: `in ${kpi.withCleanup} of ${plural(kpi.repos, 'repository', 'repositories')}`,
    },
    { value: kpi.merged, label: 'merged, not deleted', tone: kpi.merged ? 'success' : 'none' },
    { value: kpi.closed, label: 'closed merge request', tone: kpi.closed ? 'info' : 'none' },
    { value: kpi.stale, label: `stale${stale}`, tone: kpi.stale ? 'warning' : 'none' },
    {
      value: kpi.total.toLocaleString('en'),
      label: 'branches besides default',
      caption: `${kpi.open} with an open MR, kept`,
    },
    ...(kpi.delta !== undefined
      ? [{ value: signed(kpi.delta), label: 'since previous run', end: true }]
      : []),
    ...(kpi.oldestDays !== undefined
      ? [
          {
            value: `${kpi.oldestDays} days`,
            label: 'oldest',
            ...(kpi.delta === undefined ? { end: true } : {}),
          },
        ]
      : []),
  ]
}

function columns({
  narrowed,
  selected,
  setSelected,
  visibleKeys,
}: {
  narrowed: boolean
  selected: ReadonlySet<string>
  setSelected: (next: Set<string>) => void
  visibleKeys: readonly string[]
}): FleetColumn<BranchListRow, BranchesSortKey>[] {
  const all = selectAllState(selected, visibleKeys)
  return [
    {
      id: 'select',
      header: (
        <Checkbox
          label={<span className="sr-only">Select all shown branches</span>}
          isSelected={all === 'all'}
          isIndeterminate={all === 'some'}
          isDisabled={!visibleKeys.length}
          onChange={(on) => setSelected(selectAll(selected, visibleKeys, on))}
        />
      ),
      className: 'w-9 pr-0',
      cell: (row) => (
        <Checkbox
          label={
            <span className="sr-only">
              Select {row.name} in {row.repo.path}
            </span>
          }
          isSelected={selected.has(row.key)}
          onChange={(on) => setSelected(selectOne(selected, row.key, on))}
        />
      ),
    },
    {
      id: 'branch',
      header: 'Branch',
      sortKey: 'branch',
      className: 'min-w-56',
      cell: (row) => (
        <span className="flex flex-col gap-0.5">
          {row.webUrl ? (
            <a
              href={row.webUrl}
              target="_blank"
              rel="noreferrer"
              className="mono inline-flex items-center gap-1 text-[12.5px] hover:underline"
            >
              {row.name}
              <ExternalLink aria-label="on the forge" className="size-3 text-dim" />
            </a>
          ) : (
            <span className="mono text-[12.5px]">{row.name}</span>
          )}
          {narrowed ? null : (
            <Link
              to="/repos/$"
              params={{ _splat: repoSplat(row.repo) }}
              search={{ tab: 'quality', section: 'branches' }}
              className="mono truncate text-[11px] text-dim hover:text-foreground hover:underline"
            >
              {row.repo.path}
            </Link>
          )}
        </span>
      ),
    },
    {
      id: 'reason',
      header: 'Reason',
      sortKey: 'reason',
      cell: (row) => (
        <Tag tone={reasonTone[row.reason]} dot>
          {reasonLabel[row.reason]}
        </Tag>
      ),
    },
    {
      id: 'author',
      header: 'Author',
      sortKey: 'author',
      cell: (row) =>
        row.author ? (
          <span className="text-[12.5px]">{row.author}</span>
        ) : (
          <span className="text-dim">Unknown</span>
        ),
    },
    {
      id: 'age',
      header: 'Last commit',
      sortKey: 'age',
      className: 'whitespace-nowrap',
      cell: (row) => (
        <span className="flex flex-col gap-0.5">
          <span className="tabular text-[12.5px]">{plural(row.ageDays, 'day')} ago</span>
          <span className="mono text-[11px] text-dim">{formatDate(row.committedAt)}</span>
        </span>
      ),
    },
    {
      id: 'mr',
      header: 'Merge request',
      sortKey: 'mr',
      cell: (row) =>
        row.mergeRequest ? (
          <span className="flex flex-col gap-0.5">
            <a
              href={row.mergeRequest.url}
              target="_blank"
              rel="noreferrer"
              title={row.mergeRequest.title}
              className="mono text-[12.5px] hover:underline"
            >
              !{row.mergeRequest.iid}
            </a>
            <span className="text-[11px] text-dim">{mrState[row.mergeRequest.state]}</span>
          </span>
        ) : (
          <span className="text-dim">None</span>
        ),
    },
  ]
}

/**
 * The Branches table over `GET /api/branches`, or one repository's part of it with `repo`: scope
 * switch, Strip with the change since the previous run, reason, author and age filters, a
 * sortable row per branch worth deleting with a checkbox, and a read-only side sheet with the
 * selection, the per-author breakdown and the changes. Nothing is deleted from here.
 */
export function BranchesBody({
  repo,
  search,
  update,
}: {
  repo?: RepoRef
  search: BranchesSearch
  update: (patch: Partial<BranchesSearch>) => void
}) {
  const overview = useBranchesOverview()
  const { view, setView, homeGroups } = useScope()
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  if (overview.isPending) return <Placeholder className="h-72" />
  if (overview.isError) return <ErrorState error={overview.error} />

  const key = repo ? repoKey(repo) : search.repo
  const keyRepo = repo ?? parseRepoKey(key)
  const filters = { ...search, ...(key ? { repo: key } : {}) }
  const repos = filterBranchRepos(overview.data.repos, filters)
  const scoped = !key
  const mine = scoped && view === 'mine'
  const scopeRepos = mine ? foldOtherTeams(repos, homeGroups, (row) => row.groups).mine : repos
  const all = branchListRows(overview.data)
  const candidates = filterBranchesExceptReason(all, filters)
  const counts = reasonCounts(
    mine ? foldOtherTeams(candidates, homeGroups, (row) => row.groups).mine : candidates,
  )
  const rows = sortRows(
    oldestFirst(
      search.reason ? candidates.filter((row) => row.reason === search.reason) : candidates,
    ),
    branchesSort(search),
    branchSortValue,
  )
  const visible = mine ? foldOtherTeams(rows, homeGroups, (row) => row.groups).mine : rows
  const visibleKeys = visible.map((row) => row.key)
  const selectedRows = all.filter((row) => selected.has(row.key))
  const selectedRepos = new Set(selectedRows.map((row) => row.repoKey)).size
  const filtered = Boolean(search.q || search.reason || search.author?.length || search.age)
  const authors = [...new Set(all.map((row) => row.author ?? 'unknown'))].toSorted()
  const sheetOpen = selectedRows.length > 0 || search.panel !== undefined
  const selectMergedClosed = () =>
    setSelected(
      selectAll(
        selected,
        visible.filter((row) => row.reason !== 'stale').map((row) => row.key),
        true,
      ),
    )
  const more = repos.reduce((sum, entry) => sum + entry.more, 0)

  if (!repos.length)
    return (
      <EmptyState
        icon={<GitBranch />}
        title={key ? 'Branches not analyzed yet' : 'No branch analysis yet'}
        description="A run lists merged, abandoned and stale branches worth deleting."
        action={
          <RunJobButton
            analyzer="branches"
            label="Run now"
            size="sm"
            {...(keyRepo ? { repo: keyRepo } : {})}
          />
        }
      />
    )

  return (
    <>
      {selectedRows.length ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted" aria-live="polite">
          <span>
            <b className="tabular font-semibold text-foreground">{selectedRows.length}</b> selected
            in {plural(selectedRepos, 'repository', 'repositories')}
          </span>
          <Button size="sm" variant="ghost" onPress={() => update({ panel: 'selection' })}>
            Show by repository
          </Button>
          <Button size="sm" variant="ghost" onPress={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      ) : null}
      <FleetTable<BranchListRow, BranchesSortKey>
        label="Branches to clean up"
        rows={rows}
        rowKey={(row) => row.key}
        columns={columns({ narrowed: Boolean(key), selected, setSelected, visibleKeys })}
        sort={branchesSort(search)}
        onSort={(next) =>
          update(
            next ? { sort: next.key, dir: next.direction } : { sort: undefined, dir: undefined },
          )
        }
        {...(scoped ? { scope: { value: view, onChange: setView, homeGroups } } : {})}
        strip={() => kpiCells(branchKpis(scopeRepos))}
        noun={{ one: 'branch', many: 'branches' }}
        othersSummary={(others) => `${plural(others.length, 'branch', 'branches')} to clean up`}
        caption={
          <>
            branches with an open merge request are never listed
            {more ? ` · ${more} more not listed, oldest shown first` : ''}
          </>
        }
        onOpen={(row) => setSelected(selectOne(selected, row.key, !selected.has(row.key)))}
        toolbar={
          <>
            <Segmented<BranchCleanupReason | 'all'>
              aria-label="Reason"
              value={search.reason ?? 'all'}
              onChange={(reason) => update({ reason: reason === 'all' ? undefined : reason })}
              options={[
                { id: 'all', label: `All ${counts.all}` },
                ...branchReasons.map((reason) => ({
                  id: reason,
                  label: `${reasonLabel[reason]} ${counts[reason]}`,
                })),
              ]}
            />
            {authors.length > 1 ? (
              <FilterButton
                label="Author"
                options={authors.map((id) => ({
                  id,
                  label: id === 'unknown' ? 'Unknown' : id,
                }))}
                value={search.author ?? []}
                onChange={(author) => update({ author: author.length ? author : undefined })}
              />
            ) : null}
            <Select
              aria-label="Age"
              className="w-48"
              options={ageOptions}
              value={search.age ?? 'any'}
              onChange={(id) => update({ age: branchAges.find((days) => days === id) })}
            />
          </>
        }
        empty={
          <EmptyState
            icon={<GitBranch />}
            title={filtered ? 'No branch matches' : 'Nothing to clean up'}
            description={
              filtered
                ? 'Change or clear the filters to see more.'
                : 'Every branch is the default branch, recent or has an open merge request.'
            }
          />
        }
      />
      <BranchesSheet
        open={sheetOpen}
        panel={search.panel ?? 'selection'}
        onPanel={(panel) => update({ panel })}
        onClose={() => {
          setSelected(new Set())
          update({ panel: undefined })
        }}
        rows={all}
        repos={scopeRepos}
        selected={selected}
        onSelectMergedClosed={selectMergedClosed}
        onClear={() => setSelected(new Set())}
      />
    </>
  )
}
