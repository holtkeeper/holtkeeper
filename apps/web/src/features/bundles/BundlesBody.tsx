import type { RepoRef } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { Package } from 'lucide-react'

import { useBundlesOverview } from '../../api/queries.ts'
import {
  type BundleKpis,
  type BundleRow,
  type BundlesSearch,
  type BundlesSortKey,
  budgetShare,
  budgetState,
  budgetStateLabel,
  budgetStateTone,
  budgetStates,
  bundleKpis,
  bundleRowKey,
  bundleRows,
  bundleSortValue,
  bundlesSort,
  deltaPercent,
  filterBundleRows,
  rowRelease,
  worstFirst,
} from '../../lib/bundles.ts'
import { neighbours } from '../../lib/flow.ts'
import { formatDateTime, formatRelative, plural } from '../../lib/format.ts'
import { foldScope } from '../../lib/home-scope.ts'
import { parseRepoKey, repoKey, repoSplat } from '../../lib/repo.ts'
import { sortRows } from '../../lib/table-sort.ts'
import { formatValue } from '../../lib/units.ts'
import { statusColor } from '../../ui/colors.ts'
import {
  EmptyState,
  ErrorState,
  type FleetColumn,
  FilterButton,
  FleetTable,
  Placeholder,
  type StripCell,
  Tag,
} from '../../ui/index.ts'
import { RunJobButton } from '../jobs/RunJobDialog.tsx'
import { useScope } from '../shell/scope.ts'
import { BundleSheet } from './BundleSheet.tsx'
import { Delta } from './Delta.tsx'

const bytes = (value: number | undefined) => formatValue(value, 'bytes')

const kindOptions = [
  { id: 'build', label: 'Apps' },
  { id: 'package', label: 'Packages' },
]

const budgetOptions = budgetStates.map((id) => ({ id, label: budgetStateLabel[id] }))

function kpiCells(kpi: BundleKpis): StripCell[] {
  return [
    {
      value: kpi.targets,
      label: 'build targets',
      caption: `${plural(kpi.builds, 'app')} · ${plural(kpi.packages, 'package')}`,
    },
    { value: kpi.over, label: 'over budget', tone: kpi.over ? 'danger' : 'none' },
    { value: kpi.near, label: 'near budget, 90% or more', tone: kpi.near ? 'warning' : 'none' },
    {
      value: kpi.grew,
      label: 'grew since previous release',
      ...(kpi.grew ? { caption: `+${bytes(kpi.grewBy)} in all` } : {}),
    },
    { value: kpi.failed, label: 'build failed', tone: kpi.failed ? 'danger' : 'none' },
  ]
}

function BudgetCell({ row }: { row: BundleRow }) {
  const state = budgetState(row)
  const share = budgetShare(row)
  if (share === undefined || !row.budget)
    return (
      <Tag tone={budgetStateTone[state]} dot={state === 'failed'}>
        {budgetStateLabel[state]}
      </Tag>
    )
  return (
    <span className="flex flex-col gap-1">
      <span className="flex items-center gap-2">
        <span
          role="img"
          aria-label={`${Math.round(share * 100)}% of ${bytes(row.budget)}`}
          className="relative h-1.5 w-16 overflow-hidden rounded-sm bg-line-strong"
        >
          <span
            className="absolute inset-y-0 left-0 rounded-sm"
            style={{
              width: `${Math.min(share, 1) * 100}%`,
              background: statusColor[budgetStateTone[state]],
            }}
          />
        </span>
        <span className="text-[12.5px]">{budgetStateLabel[state]}</span>
      </span>
      <span className="mono text-[11px] text-dim">
        {Math.round(share * 100)}% of {bytes(row.budget)}
      </span>
    </span>
  )
}

function columns(narrowed: boolean): FleetColumn<BundleRow, BundlesSortKey>[] {
  return [
    {
      id: 'target',
      header: 'Target',
      sortKey: 'target',
      className: 'min-w-52',
      cell: (row) => (
        <span className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            <span className="mono text-[12.5px]">{row.name}</span>
            <Tag>{row.source === 'package' ? 'Package' : 'App'}</Tag>
          </span>
          {narrowed ? null : (
            <Link
              to="/repos/$"
              params={{ _splat: repoSplat(row.repo) }}
              search={{ tab: 'quality', section: 'bundles' }}
              className="mono truncate text-[11px] text-dim hover:text-foreground hover:underline"
            >
              {row.repo.path}
            </Link>
          )}
        </span>
      ),
    },
    {
      id: 'release',
      header: 'Release',
      sortKey: 'release',
      className: 'whitespace-nowrap',
      cell: (row) => (
        <span className="flex flex-col gap-0.5">
          <span className="mono text-[12.5px]">{rowRelease(row) ?? '—'}</span>
          <span className="text-[11px] text-dim" title={formatDateTime(row.createdAt)}>
            {formatRelative(row.createdAt)}
          </span>
        </span>
      ),
    },
    {
      id: 'size',
      header: 'Total, gzip',
      sortKey: 'size',
      align: 'right',
      cell: (row) =>
        row.status === 'failed' ? (
          <Tag tone="danger" dot>
            Build failed
          </Tag>
        ) : (
          <span className="tabular mono text-[12.5px]">{bytes(row.gzip)}</span>
        ),
    },
    {
      id: 'delta',
      header: 'vs previous',
      sortKey: 'delta',
      align: 'right',
      cell: (row) => {
        const percent = deltaPercent(row)
        return (
          <span className="flex flex-col items-end gap-0.5 text-[12.5px]">
            <Delta value={row.delta} />
            {percent !== undefined && row.delta ? (
              <span className="mono text-[11px] text-dim">
                {percent > 0 ? '+' : '−'}
                {Math.abs(percent).toFixed(1)}%
              </span>
            ) : null}
          </span>
        )
      },
    },
    {
      id: 'budget',
      header: 'Budget used',
      sortKey: 'budget',
      cell: (row) => <BudgetCell row={row} />,
    },
    {
      id: 'initial',
      header: 'Largest entrypoint',
      sortKey: 'initial',
      align: 'right',
      cell: (row) =>
        row.initial === undefined ? (
          <span className="text-dim">—</span>
        ) : (
          <span className="flex flex-col items-end gap-0.5">
            <span className="tabular mono text-[12.5px]">{bytes(row.initial)}</span>
            <span className="text-[11px] text-dim">initial</span>
          </span>
        ),
    },
  ]
}

/**
 * The Bundles table over `GET /api/bundles`, or one repository's part of it with `repo`: scope
 * switch, Strip, kind and budget filters, a sortable row per target and the target's side sheet.
 * `search` holds the filters, the sort and the open target.
 */
export function BundlesBody({
  repo,
  search,
  update,
}: {
  repo?: RepoRef
  search: BundlesSearch
  update: (patch: Partial<BundlesSearch>) => void
}) {
  const overview = useBundlesOverview()
  const { view, setView, homeGroups } = useScope()
  if (overview.isPending) return <Placeholder className="h-72" />
  if (overview.isError) return <ErrorState error={overview.error} />

  const narrowed = repo !== undefined
  const key = repo ? repoKey(repo) : search.repo
  const keyRepo = repo ?? parseRepoKey(key)
  const all = bundleRows(overview.data)
  const sort = bundlesSort(search)
  const rows = sortRows(
    worstFirst(filterBundleRows(all, { ...search, ...(key ? { repo: key } : {}) })),
    sort,
    bundleSortValue,
  )
  const scoped = !narrowed && !key
  const keys = (scoped ? foldScope(rows, view, homeGroups, (row) => row.groups).shown : rows).map(
    (row) => row.key,
  )
  const openKey =
    search.open && search.target ? bundleRowKey(search.open, search.target) : undefined
  const step = neighbours(keys, openKey)
  const current = all.find((row) => row.key === openKey)
  const filtered = Boolean(search.q || search.kind?.length || search.budget?.length)
  const go = (row: BundleRow) =>
    update({
      open: row.repoKey,
      target: row.name,
      version: undefined,
      analysis: undefined,
    })
  const byKey = (target: string | undefined) => all.find((row) => row.key === target)

  if (!all.length || (key && !all.some((row) => row.repoKey === key)))
    return (
      <EmptyState
        icon={<Package />}
        title="Nothing measured yet"
        description="A run builds the apps of a repository and downloads the packages it publishes. Past releases can be measured too."
        action={
          <RunJobButton
            analyzer="bundle"
            label="Measure now"
            size="sm"
            {...(keyRepo ? { repo: keyRepo } : {})}
          />
        }
      />
    )

  return (
    <>
      <FleetTable<BundleRow, BundlesSortKey>
        label="Bundle targets"
        rows={rows}
        rowKey={(row) => row.key}
        columns={columns(Boolean(key))}
        sort={sort}
        onSort={(next) =>
          update(
            next ? { sort: next.key, dir: next.direction } : { sort: undefined, dir: undefined },
          )
        }
        {...(narrowed || key ? {} : { scope: { value: view, onChange: setView, homeGroups } })}
        strip={(shown) => kpiCells(bundleKpis(shown))}
        noun={{ one: 'build target', many: 'build targets' }}
        othersSummary={(others) => {
          const over = others.filter((row) => budgetState(row) === 'over').length
          return over ? `${over} over budget` : undefined
        }}
        caption="newest measurement of each app build and published package · budgets set in Configure"
        onOpen={go}
        toolbar={
          <>
            <FilterButton
              label="Kind"
              all="Apps and packages"
              options={kindOptions}
              value={search.kind ?? []}
              onChange={(kind) =>
                update({
                  kind: kind.length
                    ? kind.flatMap((id) => (id === 'build' || id === 'package' ? [id] : []))
                    : undefined,
                })
              }
            />
            <FilterButton
              label="Budget"
              options={budgetOptions}
              value={search.budget ?? []}
              onChange={(budget) =>
                update({
                  budget: budget.length
                    ? budgetStates.filter((state) => budget.includes(state))
                    : undefined,
                })
              }
            />
          </>
        }
        empty={
          <EmptyState
            icon={<Package />}
            title={filtered ? 'No target matches' : 'No build targets'}
            description={
              filtered ? 'Change or clear the filters to see more.' : 'Nothing measured in scope.'
            }
          />
        }
      />
      <BundleSheet
        row={current}
        tab={search.tab}
        pick={{
          ...(search.version ? { version: search.version } : {}),
          ...(search.analysis ? { analysis: search.analysis } : {}),
        }}
        onTab={(tab) => update({ tab })}
        onPick={(pick) => update({ version: pick.version, analysis: pick.analysis })}
        onClose={() =>
          update({
            open: undefined,
            target: undefined,
            tab: undefined,
            version: undefined,
            analysis: undefined,
          })
        }
        {...(current && step.index >= 0 ? { index: step.index, total: keys.length } : {})}
        {...(step.previous
          ? {
              onPrevious: () => {
                const row = byKey(step.previous)
                if (row) go(row)
              },
            }
          : {})}
        {...(step.next
          ? {
              onNext: () => {
                const row = byKey(step.next)
                if (row) go(row)
              },
            }
          : {})}
      />
    </>
  )
}
