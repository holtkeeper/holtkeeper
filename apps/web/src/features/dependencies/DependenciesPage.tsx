import type { DependencyRow } from '@holtkeeper/api'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { Maximize2, Package } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { useDependencies } from '../../api/queries.ts'
import { analysisPages } from '../../lib/analyses.ts'
import {
  type DependencyFilter,
  type LibraryTab,
  behindLabel,
  behindTone,
  filterRows,
  libraryKey,
  parseLibraryKey,
  otherTeamRows,
  parseLibraryTab,
  scopeRows,
  tileCounts,
} from '../../lib/dependencies.ts'
import { neighbours } from '../../lib/flow.ts'
import { plural } from '../../lib/format.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import { pageSettingKeys } from '../../lib/settings-tabs.ts'
import {
  EmptyState,
  ErrorState,
  LoadMore,
  OtherTeams,
  Page,
  Placeholder,
  ScopeSwitch,
  SearchInput,
  Segmented,
  SegmentBar,
  Select,
  SeverityChip,
  SideSheet,
  Tag,
  Table,
  Td,
  Th,
  Tooltip,
} from '../../ui/index.ts'
import { RepoSelect } from '../analyses/AnalysesPage.tsx'
import { RunJobButton } from '../jobs/RunJobDialog.tsx'
import { SettingsButton } from '../settings/SettingsSheet.tsx'
import { useScope } from '../shell/scope.ts'
import { LibraryDetail } from './LibraryDetail.tsx'

const page = analysisPages.find((p) => p.kind === 'depgraph') ?? analysisPages[1]
const pageSize = 60

const filters = [
  { id: 'all', label: 'Third-party' },
  { id: 'behind', label: 'Behind' },
  { id: 'advisories', label: 'Advisories' },
  { id: 'updates', label: 'Update MRs' },
  { id: 'internal', label: 'Internal' },
] as const satisfies readonly { id: DependencyFilter; label: string }[]

interface DependenciesSearch {
  repo?: string
  library?: string
  tab?: string
}

function Tile({
  label,
  value,
  hint,
  tone,
  active,
  onPress,
}: {
  label: string
  value: number
  hint: string
  tone: 'danger' | 'warning' | 'info'
  active: boolean
  onPress: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onPress}
      className={`flex flex-col gap-1 rounded-xl border bg-panel p-3.5 text-left transition-colors hover:bg-raise ${active ? 'border-line-strong shadow-[0_0_0_1px_var(--line-strong)]' : 'border-line'}`}
    >
      <span className="flex items-center gap-2 text-xs text-muted">
        <span
          aria-hidden
          className="size-1.5 rounded-full"
          style={{
            background: `var(--${tone === 'danger' ? 'bad' : tone === 'warning' ? 'warn' : 'info'})`,
          }}
        />
        {label}
      </span>
      <span className="tabular text-xl font-semibold">{value}</span>
      <span className="text-xs text-muted">{hint}</span>
    </button>
  )
}

/**
 * One row per library the readable repositories use: version spread, latest, how far behind,
 * advisories and update merge requests, scoped to the viewer's team by default. A row opens the
 * library in a side sheet with Overview, Upgrade and Docs; J and K step through the list.
 */
export function DependenciesPage() {
  const search: DependenciesSearch = useSearch({ strict: false })
  const navigate = useNavigate()
  const repo = parseRepoKey(search.repo)
  const open = parseLibraryKey(search.library)
  const tab = parseLibraryTab(search.tab)
  const table = useDependencies()
  const { view, setView, homeGroups } = useScope()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<DependencyFilter>('all')
  const [ecosystem, setEcosystem] = useState('*')
  const [limit, setLimit] = useState(pageSize)
  const [foldedLimit, setFoldedLimit] = useState(pageSize)
  const [othersOpen, setOthersOpen] = useState(false)
  const resetLimits = () => {
    setLimit(pageSize)
    setFoldedLimit(pageSize)
  }

  const go = (next: { library?: string; tab?: LibraryTab }) =>
    void navigate({
      to: '/dependencies',
      search: {
        ...(search.repo ? { repo: search.repo } : {}),
        ...(next.library ? { library: next.library } : {}),
        ...(next.library && next.tab && next.tab !== 'overview' ? { tab: next.tab } : {}),
      },
      replace: true,
    })
  const pick = (next: DependencyFilter) => {
    setFilter(next === filter && next !== 'all' ? 'all' : next)
    resetLimits()
  }

  const data = table.data
  const scoped = data
    ? scopeRows(data.libraries, data.repos, repo ? 'all' : view, homeGroups)
    : undefined
  const tiles = tileCounts(scoped?.shown ?? [])
  const rows = filterRows(scoped?.shown ?? [], {
    query,
    ecosystem,
    filter,
    ...(repo ? { repo: repoKey(repo) } : {}),
  })
  const folded =
    data && !repo && view === 'mine'
      ? otherTeamRows(data.libraries, data.repos, homeGroups)
      : undefined
  const foldedRows = folded ? filterRows(folded.rows, { query, ecosystem, filter }) : []
  const visible = rows.slice(0, limit)
  const foldedVisible = foldedRows.slice(0, foldedLimit)
  const keys = [...visible, ...(othersOpen ? foldedVisible : [])].map(libraryKey)
  const step = neighbours(keys, search.library)
  const ecosystems = [...new Set((data?.libraries ?? []).map((row) => row.ecosystem))].toSorted()

  const body = () => {
    if (table.isPending) return <Placeholder className="h-96" />
    if (table.isError) return <ErrorState error={table.error} />
    if (!data?.libraries.length)
      return (
        <EmptyState
          icon={<Package />}
          title="No dependencies yet"
          description="Run the Dependencies analysis on a repository; its lockfile shows up here."
        />
      )
    if (!repo && view === 'others' && scoped)
      return (
        <p className="text-sm text-muted">
          {plural(scoped.others.libraries, 'library', 'libraries')} in{' '}
          {plural(scoped.others.repos, 'repository', 'repositories')} of{' '}
          {plural(scoped.others.teams, 'other team')}.{' '}
          <button
            type="button"
            className="text-foreground hover:underline"
            onClick={() => setView('all')}
          >
            Show them
          </button>
        </p>
      )
    return (
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Tile
            label="Behind a major"
            value={tiles.behindMajor}
            hint="third-party libraries a repository lags on"
            tone="danger"
            active={filter === 'behind'}
            onPress={() => pick('behind')}
          />
          <Tile
            label="Known advisories"
            value={tiles.withAdvisories}
            hint="libraries with advisories in the newest audits"
            tone="warning"
            active={filter === 'advisories'}
            onPress={() => pick('advisories')}
          />
          <Tile
            label="Update MRs waiting / broken"
            value={tiles.renovateOpen + tiles.renovateBroken}
            hint={`${tiles.renovateBroken} broken`}
            tone="info"
            active={filter === 'updates'}
            onPress={() => pick('updates')}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            aria-label="Filter libraries"
            placeholder="Filter by library"
            value={query}
            onChange={(value) => {
              setQuery(value)
              resetLimits()
            }}
            className="w-64"
          />
          <Segmented aria-label="Show" options={filters} value={filter} onChange={pick} />
          {ecosystems.length > 1 ? (
            <Select
              aria-label="Ecosystem"
              className="w-40"
              options={[
                { id: '*', label: 'All ecosystems' },
                ...ecosystems.map((id) => ({ id, label: id })),
              ]}
              value={ecosystem}
              onChange={setEcosystem}
            />
          ) : null}
          <span className="ml-auto text-xs text-muted">
            {plural(rows.length, 'library', 'libraries')}
          </span>
        </div>
        <div className="rounded-xl border border-line bg-panel">
          {rows.length ? (
            <LibraryTable
              rows={visible}
              selected={search.library}
              onOpen={(row) => go({ library: libraryKey(row), tab })}
              footer={
                rows.length > visible.length ? (
                  <LoadMore variant="ghost" onLoad={() => setLimit(limit + pageSize)}>
                    Show {Math.min(pageSize, rows.length - visible.length)} more of{' '}
                    {rows.length - visible.length}
                  </LoadMore>
                ) : undefined
              }
            />
          ) : (
            <EmptyState
              icon={<Package />}
              title="No library matches"
              description="Try another filter."
            />
          )}
        </div>
        {folded ? (
          <OtherTeams
            count={foldedRows.length}
            teams={folded.teams}
            open={othersOpen}
            onOpenChange={setOthersOpen}
          >
            <div className="rounded-xl border border-line bg-panel">
              <LibraryTable
                rows={foldedVisible}
                selected={search.library}
                onOpen={(row) => go({ library: libraryKey(row), tab })}
                footer={
                  foldedRows.length > foldedVisible.length ? (
                    <LoadMore variant="ghost" onLoad={() => setFoldedLimit(foldedLimit + pageSize)}>
                      Show {Math.min(pageSize, foldedRows.length - foldedVisible.length)} more of{' '}
                      {foldedRows.length - foldedVisible.length}
                    </LoadMore>
                  ) : undefined
                }
              />
            </div>
          </OtherTeams>
        ) : null}
      </div>
    )
  }

  return (
    <Page
      title="Dependencies"
      icon={page.icon}
      description={
        repo
          ? `Libraries ${repoKey(repo)} uses`
          : 'Which libraries the repositories use, how far behind they are and what is known about them'
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {scoped && !repo ? (
            <ScopeSwitch value={view} onChange={setView} counts={scoped.counts} />
          ) : null}
          <RepoSelect to={page.to} />
          <RunJobButton
            analyzer="depgraph"
            label="Run now"
            variant="secondary"
            {...(repo ? { repo } : {})}
          />
          <SettingsButton title="Dependency settings" keys={pageSettingKeys.dependencies} />
        </div>
      }
    >
      {body()}
      <SideSheet
        open={open !== undefined}
        onClose={() => go({})}
        id={open?.ecosystem}
        title={open?.name ?? ''}
        {...(step.index >= 0 ? { index: step.index, total: keys.length } : {})}
        {...(step.previous ? { onPrevious: () => go({ library: step.previous, tab }) } : {})}
        {...(step.next ? { onNext: () => go({ library: step.next, tab }) } : {})}
        actions={
          open ? (
            <Tooltip content="Open as a page">
              <Link
                to="/dependencies/$ecosystem/$"
                params={{ ecosystem: open.ecosystem, _splat: open.name }}
                search={tab !== 'overview' ? { tab } : {}}
                aria-label="Open as a page"
                className="grid size-7 place-items-center rounded-md text-muted hover:bg-raise hover:text-foreground"
              >
                <Maximize2 className="size-3.5" />
              </Link>
            </Tooltip>
          ) : null
        }
      >
        {open ? (
          <LibraryDetail
            key={libraryKey(open)}
            library={open}
            tab={tab}
            onTab={(next) => go({ library: libraryKey(open), tab: next })}
          />
        ) : null}
      </SideSheet>
    </Page>
  )
}

function LibraryTable({
  rows,
  selected,
  onOpen,
  footer,
}: {
  rows: readonly DependencyRow[]
  selected: string | undefined
  onOpen: (row: DependencyRow) => void
  footer?: ReactNode
}) {
  return (
    <Table label="Libraries" {...(footer ? { footer } : {})}>
      <thead>
        <tr>
          <Th>Library</Th>
          <Th>Version spread</Th>
          <Th>Latest</Th>
          <Th>Behind</Th>
          <Th>Update MRs</Th>
          <Th align="right">Advisories</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <LibraryRow
            key={libraryKey(row)}
            row={row}
            selected={selected === libraryKey(row)}
            onOpen={() => onOpen(row)}
          />
        ))}
      </tbody>
    </Table>
  )
}

function LibraryRow({
  row,
  selected,
  onOpen,
}: {
  row: DependencyRow
  selected: boolean
  onOpen: () => void
}) {
  return (
    <tr
      className={`cursor-pointer hover:bg-raise ${selected ? 'bg-raise' : ''}`}
      onClick={onOpen}
      aria-selected={selected}
    >
      <Td className="max-w-[22rem]">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="mono truncate text-left text-[13px] font-medium hover:underline"
            onClick={(event) => {
              event.stopPropagation()
              onOpen()
            }}
          >
            {row.name}
          </button>
          <Tag mono>{row.ecosystem}</Tag>
          {row.internal ? <Tag tone="accent">internal</Tag> : null}
        </div>
      </Td>
      <Td className="min-w-40">
        <div className="flex flex-col gap-1">
          <SegmentBar
            className="w-36"
            segments={row.versions.map((entry) => ({
              value: entry.repos,
              tone: behindTone(entry.majorsBehind),
              label: `on ${entry.version}`,
            }))}
          />
          <span className="mono text-xs text-muted">
            {plural(row.versions.length, 'version')} · {plural(row.usedBy.length, 'repo')}
          </span>
        </div>
      </Td>
      <Td className="mono text-[13px]">{row.latest ?? '—'}</Td>
      <Td>
        {row.latest ? (
          <Tag tone={behindTone(row.majorsBehind)}>
            {behindLabel(row.majorsBehind)}
            {row.reposBehind ? ` · ${row.reposBehind}` : ''}
          </Tag>
        ) : (
          <span className="text-muted">—</span>
        )}
      </Td>
      <Td>
        {row.renovate === 'none' ? (
          <span className="text-muted">—</span>
        ) : (
          <Tag tone={row.renovate === 'broken' ? 'danger' : 'default'}>
            {row.renovate === 'broken' ? 'broken' : 'open'}
          </Tag>
        )}
      </Td>
      <Td align="right">
        {row.advisories.count && row.advisories.severity ? (
          <SeverityChip severity={row.advisories.severity} count={row.advisories.count} compact />
        ) : row.advisories.count ? (
          <span className="tabular">{row.advisories.count}</span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </Td>
    </tr>
  )
}
