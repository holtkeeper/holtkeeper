import { type RepoRef, formatBytes } from '@holtkeeper/api'
import { Link, useNavigate } from '@tanstack/react-router'
import { Images } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { useAssets } from '../../api/queries.ts'
import {
  type AssetTableRow,
  type AssetsKpis,
  type AssetsSearch,
  assetKinds,
  assetTableRows,
  assetsKpis,
  canOptimize,
  kindColor,
  kindLabel,
  problemLabel,
  rowMeta,
  savingPercent,
  searchAssetRows,
  severityTone,
  singleChoice,
  toAssetsQuery,
  trendText,
} from '../../lib/assets.ts'
import { plural } from '../../lib/format.ts'
import { foldOtherTeams } from '../../lib/home-scope.ts'
import { parseRepoKey, repoKey, repoSplat } from '../../lib/repo.ts'
import {
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  type FleetColumn,
  FilterButton,
  FleetTable,
  LoadMore,
  Placeholder,
  Segmented,
  Select,
  type StripCell,
  Tag,
} from '../../ui/index.ts'
import { MiniSparkline } from '../../ui/MiniSparkline.tsx'
import { RunJobButton } from '../jobs/RunJobDialog.tsx'
import { type MediaTarget, MediaSheet } from '../media/MediaSheet.tsx'
import { useScope } from '../shell/scope.ts'

function stripCells(kpi: AssetsKpis, narrowed: boolean, trend: readonly number[]): StripCell[] {
  const share = kpi.bytes ? Math.round((kpi.savings / kpi.bytes) * 100) : 0
  return [
    {
      prefix: 'Asset weight',
      value: formatBytes(kpi.bytes),
      label: narrowed ? '' : `in ${plural(kpi.repos, 'repository', 'repositories')}`,
    },
    {
      prefix: 'Potential saving',
      value: formatBytes(kpi.savings),
      label: '',
      ...(share ? { caption: `(${share}%)` } : {}),
    },
    { value: kpi.files.toLocaleString('en'), label: 'files checked' },
    {
      value: kpi.errors.toLocaleString('en'),
      label: kpi.errors === 1 ? 'error' : 'errors',
      tone: kpi.errors ? 'danger' : 'none',
    },
    {
      value: kpi.warnings.toLocaleString('en'),
      label: kpi.warnings === 1 ? 'warning' : 'warnings',
      tone: kpi.warnings ? 'warning' : 'none',
    },
    ...(kpi.duplicateBytes
      ? [{ prefix: 'Duplicates', value: formatBytes(kpi.duplicateBytes), label: '' }]
      : []),
    ...(kpi.budgets ? [{ prefix: 'Budgets exceeded', value: kpi.budgets, label: '' }] : []),
    ...(trend.length > 1 || kpi.trend !== undefined
      ? [
          {
            end: true,
            prefix:
              trend.length > 1 ? (
                <span className="inline-flex items-center gap-1.5 align-middle">
                  <MiniSparkline
                    values={trend}
                    color="var(--fg-muted)"
                    label="Total asset bytes of recent analyses"
                    className="h-[18px] w-[72px]"
                  />
                  Weight, {trend.length} analyses
                </span>
              ) : (
                'Weight'
              ),
            value: kpi.trend === undefined ? '' : trendText(kpi.trend),
            label: '',
          },
        ]
      : []),
  ]
}

function KindBar({ kpi, narrowed }: { kpi: AssetsKpis; narrowed: boolean }) {
  if (!kpi.kinds.length) return null
  return (
    <div className="flex flex-col gap-2 px-3.5 py-3">
      <div className="flex items-center gap-3">
        <span className="text-[11.5px] font-medium text-muted">By kind</span>
        <div
          role="img"
          aria-label={kpi.kinds
            .map((k) => `${kindLabel(k.kind)} ${formatBytes(k.bytes)}`)
            .join(', ')}
          className="flex h-2 min-w-40 flex-1 gap-0.5 overflow-hidden rounded"
        >
          {kpi.kinds.map((k) => (
            <i
              key={k.kind}
              className="block h-full"
              style={{ flexGrow: k.bytes, flexBasis: 0, background: kindColor(k.kind) }}
            />
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-[11.5px] text-muted">
        {kpi.kinds.map((k) => (
          <span key={k.kind} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block size-2 rounded-sm"
              style={{ background: kindColor(k.kind) }}
            />
            {kindLabel(k.kind)} <span className="mono">{formatBytes(k.bytes)}</span>
          </span>
        ))}
        {kpi.overBudget.length ? (
          <span className="ms-auto">
            Budgets over:{' '}
            {narrowed
              ? plural(kpi.budgets, 'budget')
              : kpi.overBudget.map((repo, index) => (
                  <span key={repoKey(repo)}>
                    {index ? ', ' : ''}
                    <span className="mono">{repo.path}</span>
                  </span>
                ))}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function RepoCell({ repo }: { repo: RepoRef }) {
  return (
    <Link
      to="/repos/$"
      params={{ _splat: repoSplat(repo) }}
      search={{ tab: 'quality', section: 'assets' }}
      className="mono truncate text-[12.5px] hover:underline"
    >
      {repo.path}
    </Link>
  )
}

const statusOptions = [
  { id: 'policy', label: 'Breaks the policy' },
  { id: 'saving', label: 'Any saving' },
  { id: 'any', label: 'Everything' },
] as const

const sortOptions = [
  { id: 'severity', label: 'Sort: Severity' },
  { id: 'saving', label: 'Sort: Saving' },
  { id: 'size', label: 'Sort: Size' },
] as const

const mediaTarget = (row: AssetTableRow): MediaTarget => ({ repo: row.repo, file: row.path })

const rowDetail = (row: AssetTableRow) => {
  const problem = row.problems[0]
  return (
    <>
      <span>
        {row.format.toUpperCase()}
        {row.width && row.height ? ` ${row.width}×${row.height}` : ''},{' '}
        <span className="mono">{formatBytes(row.bytes)}</span>
      </span>
      {problem ? <Tag tone={severityTone(problem.severity)}>{problemLabel(problem)}</Tag> : null}
    </>
  )
}

/**
 * Asset files to act on over `GET /api/assets`, or one repository's with `repo`: the summary strip
 * and bytes per kind of the repositories in scope, a paged table of files with problems and
 * potential savings, filters by status, kind, format and group, and the media optimizer sheet for
 * one file, a selection, or (`media`) a file it opens on.
 */
export function AssetsFiles({
  repo,
  search,
  update,
  trend = [],
  media: initialMedia,
  optimizeNew,
  onOptimizeNewDone,
}: {
  repo?: RepoRef
  search: AssetsSearch
  update: (patch: Partial<AssetsSearch>) => void
  /** Total bytes of recent records of the repository, oldest first. */
  trend?: readonly number[]
  /** A file to open the optimizer on at first. */
  media?: MediaTarget
  /** Opens the optimizer on a blank file, from the page's primary action. */
  optimizeNew?: boolean
  onOptimizeNewDone?: () => void
}) {
  const navigate = useNavigate()
  const { view, setView, homeGroups } = useScope()
  const key = repo ? repoKey(repo) : search.repo
  const assets = useAssets(toAssetsQuery({ ...search, ...(key ? { repo: key } : {}) }))
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [queue, setQueue] = useState<{
    targets: MediaTarget[]
    index: number
    rows?: AssetTableRow[]
  }>(() => (initialMedia ? { targets: [initialMedia], index: 0 } : { targets: [], index: 0 }))

  if (assets.isPending) return <Placeholder className="h-72" />
  if (assets.isError) return <ErrorState error={assets.error} />

  const pages = assets.data.pages
  const first = pages[0]
  const repos = first?.repos ?? []
  const total = pages.at(-1)?.total ?? 0
  const narrowed = Boolean(key)
  const keyRepo = repo ?? parseRepoKey(key)
  const mine = !narrowed && view === 'mine'
  const kpi = assetsKpis(mine ? foldOtherTeams(repos, homeGroups, (r) => r.groups).mine : repos)
  const rows = searchAssetRows(assetTableRows(pages), search.q)
  const shownRows = mine ? foldOtherTeams(rows, homeGroups, (r) => r.groups).mine : rows
  const optimizable = shownRows.filter(canOptimize)
  const chosen = optimizable.filter((row) => selected.has(row.key))
  const kinds = assetKinds.filter((kind) => repos.some((r) => (r.kinds[kind] ?? 0) > 0))
  const formats = [
    ...new Set([
      ...rows.map((row) => row.format.toLowerCase()),
      ...(search.format ? [search.format] : []),
    ]),
  ].toSorted()
  const groups = [...new Set(repos.flatMap((r) => r.groups))].toSorted()
  const filtered = Boolean(
    search.q || search.kind || search.format || search.group || search.problem,
  )
  const target =
    queue.targets[queue.index] ?? (optimizeNew ? (keyRepo ? { repo: keyRepo } : {}) : undefined)
  const currentRow = queue.rows?.[queue.index]
  const closeMedia = () => {
    setQueue({ targets: [], index: 0 })
    onOptimizeNewDone?.()
  }
  const openRows = (list: readonly AssetTableRow[], at: number) =>
    setQueue({ targets: list.map(mediaTarget), index: at, rows: [...list] })

  const sheet = target ? (
    <MediaSheet
      key={`${queue.index}:${target.repo ? repoKey(target.repo) : ''}:${target.file ?? ''}`}
      target={target}
      repos={repos.map((r) => r.repo)}
      onClose={closeMedia}
      {...(currentRow ? { detail: rowDetail(currentRow) } : {})}
      {...(queue.targets.length > 1
        ? {
            index: queue.index,
            total: queue.targets.length,
            ...(queue.index > 0
              ? { onPrevious: () => setQueue((q) => ({ ...q, index: q.index - 1 })) }
              : {}),
            ...(queue.index < queue.targets.length - 1
              ? { onNext: () => setQueue((q) => ({ ...q, index: q.index + 1 })) }
              : {}),
          }
        : {})}
    />
  ) : null

  if (!repos.length && !filtered)
    return (
      <>
        {narrowed ? (
          <EmptyState
            icon={<Images />}
            title="No assets analysis yet"
            description="Run the assets analyzer to check images, fonts and media against the policy."
            action={<RunJobButton repo={keyRepo} analyzer="assets" label="Run assets" />}
          />
        ) : (
          <EmptyState
            icon={<Images />}
            title="No assets analyses yet"
            description="Repositories show up once the assets analyzer has run on them."
          />
        )}
        {sheet}
      </>
    )

  const columns: FleetColumn<AssetTableRow>[] = [
    {
      id: 'select',
      header: optimizable.length ? (
        <Checkbox
          label={<span className="sr-only">Select every file to optimize</span>}
          isSelected={chosen.length === optimizable.length}
          onChange={(on) => setSelected(new Set(on ? optimizable.map((row) => row.key) : []))}
        />
      ) : (
        <span className="sr-only">Select</span>
      ),
      className: 'w-9 pr-0',
      cell: (row) =>
        canOptimize(row) ? (
          <Checkbox
            label={<span className="sr-only">Select {row.path}</span>}
            isSelected={selected.has(row.key)}
            onChange={(on) => {
              const next = new Set(selected)
              if (on) next.add(row.key)
              else next.delete(row.key)
              setSelected(next)
            }}
          />
        ) : null,
    },
    {
      id: 'file',
      header: 'File',
      className: 'min-w-56',
      cell: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="mono break-all text-[12.5px]">{row.path}</span>
          <span className="mt-0.5 text-[11.5px] text-dim">{rowMeta(row)}</span>
        </span>
      ),
    },
    ...(narrowed
      ? []
      : [
          {
            id: 'repo',
            header: 'Repository',
            cell: (row: AssetTableRow) => <RepoCell repo={row.repo} />,
          },
        ]),
    {
      id: 'format',
      header: 'Format',
      cell: (row) => <Tag mono>{row.format.toUpperCase()}</Tag>,
    },
    {
      id: 'size',
      header: 'Size',
      align: 'right',
      cell: (row) => <span className="mono">{formatBytes(row.bytes)}</span>,
    },
    {
      id: 'problems',
      header: 'Problems',
      cell: (row) => (
        <span className="flex flex-col items-start gap-[3px]">
          {row.problems.slice(0, 2).map((problem, index) => (
            <span key={index} className="flex flex-col items-start gap-0.5">
              <Tag tone={severityTone(problem.severity)}>{problemLabel(problem)}</Tag>
              <span className="text-[11.5px] text-dim">{problem.message}</span>
            </span>
          ))}
          {row.problems.length > 2 ? (
            <span className="text-[11.5px] text-dim">+{row.problems.length - 2} more</span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'saving',
      header: 'Potential saving',
      align: 'right',
      cell: (row) =>
        row.suggestion ? (
          <span className="flex flex-col items-end gap-[3px]">
            <span className="mono text-ok">−{formatBytes(row.suggestion.saving)}</span>
            <span className="flex items-center gap-1.5 text-[11.5px] text-dim">
              <span className="inline-block h-[5px] w-16 overflow-hidden rounded-[3px] bg-line-strong">
                <b
                  className="block h-full rounded-[3px] bg-ok"
                  style={{ width: `${savingPercent(row)}%` }}
                />
              </span>
              <span title={row.suggestion.how}>
                {row.suggestion.format.toUpperCase()} {formatBytes(row.suggestion.expectedBytes)}
                {row.suggestion.method === 'estimate' ? ' (estimate)' : ''}
              </span>
            </span>
          </span>
        ) : (
          <span className="text-dim">—</span>
        ),
    },
    {
      id: 'action',
      header: <span className="sr-only">Action</span>,
      align: 'right',
      cell: (row) =>
        canOptimize(row) ? (
          <Button
            size="sm"
            variant="secondary"
            onPress={() => openRows(optimizable, Math.max(0, optimizable.indexOf(row)))}
          >
            Optimize
          </Button>
        ) : (
          <Link
            to="/analyses/$id"
            params={{ id: row.analysisId }}
            className="text-xs text-muted hover:text-foreground"
          >
            Details
          </Link>
        ),
    },
  ]

  const scope = narrowed ? {} : { scope: { value: view, onChange: setView, homeGroups } }
  const bottom: ReactNode[] = []
  if (assets.hasNextPage)
    bottom.push(
      <LoadMore
        key="more"
        size="sm"
        onLoad={() => void assets.fetchNextPage()}
        isPending={assets.isFetchingNextPage}
      >
        Load more files
      </LoadMore>,
    )
  if (chosen.length)
    bottom.push(
      <Button key="optimize" size="sm" variant="secondary" onPress={() => openRows(chosen, 0)}>
        Optimize {chosen.length} selected
      </Button>,
    )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <FleetTable<AssetTableRow>
          label="Asset files"
          rows={rows}
          rowKey={(row) => row.key}
          columns={columns}
          {...scope}
          strip={() => stripCells(kpi, narrowed, trend)}
          stripExtra={kpi.kinds.length ? <KindBar kpi={kpi} narrowed={narrowed} /> : undefined}
          noun={{ one: 'file', many: 'files' }}
          {...(assets.hasNextPage ? { caption: `· ${total.toLocaleString('en')} match` } : {})}
          onOpen={(row) => {
            if (canOptimize(row)) openRows(optimizable, Math.max(0, optimizable.indexOf(row)))
            else void navigate({ to: '/analyses/$id', params: { id: row.analysisId } })
          }}
          toolbar={
            <>
              <Segmented
                aria-label="Files shown"
                options={statusOptions}
                value={search.status ?? 'policy'}
                onChange={(status) => update({ status: status === 'policy' ? undefined : status })}
              />
              {kinds.length > 1 ? (
                <FilterButton
                  label="Kind"
                  options={kinds.map((id) => ({ id, label: kindLabel(id) }))}
                  value={search.kind ? [search.kind] : []}
                  onChange={(next) => {
                    const kind = assetKinds.find((k) => k === singleChoice(next, search.kind))
                    update({ kind })
                  }}
                />
              ) : null}
              {formats.length > 1 ? (
                <FilterButton
                  label="Format"
                  options={formats.map((id) => ({ id, label: id.toUpperCase() }))}
                  value={search.format ? [search.format] : []}
                  onChange={(next) => update({ format: singleChoice(next, search.format) })}
                />
              ) : null}
              {!narrowed && groups.length > 1 ? (
                <FilterButton
                  label="Group"
                  options={groups.map((id) => ({ id, label: id }))}
                  value={search.group ? [search.group] : []}
                  onChange={(next) => update({ group: singleChoice(next, search.group) })}
                />
              ) : null}
              <Select
                aria-label="Sort files"
                className="w-40"
                options={sortOptions}
                value={search.sort ?? 'severity'}
                onChange={(id) =>
                  update({ sort: id === 'saving' || id === 'size' ? id : undefined })
                }
              />
            </>
          }
          empty={
            <EmptyState
              icon={<Images />}
              title={filtered ? 'No file matches' : 'Nothing to act on'}
              description={
                filtered
                  ? 'Change or clear the filters to see more.'
                  : search.status === 'saving'
                    ? 'No file has a saving worth making.'
                    : 'Every file follows the asset policy.'
              }
            />
          }
        />
        {bottom.length ? (
          <div className="flex flex-wrap items-center justify-end gap-2">{bottom}</div>
        ) : null}
      </div>
      {sheet}
    </div>
  )
}
