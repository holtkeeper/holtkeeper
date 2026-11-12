import type { DependencyTable, RepoRef } from '@holtkeeper/api'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { Braces, Copy, Download, Package, Rocket } from 'lucide-react'
import { useState } from 'react'

import { useDependencies, useDependency } from '../../api/queries.ts'
import {
  type DependencyFilter,
  type LibrariesSearch,
  type LibrariesSortKey,
  type LibraryFleetRow,
  behindLabel,
  behindTone,
  dependencyFilters,
  filterCounts,
  filterRows,
  librariesSort,
  libraryKey,
  librarySheetTabs,
  libraryTotals,
  parseLibraryKey,
  parseLibraryTab,
  scopeLibraryRows,
  sortRows,
  toCsv,
  upgradeVersions,
  withLibrariesSort,
} from '../../lib/dependencies.ts'
import { neighbours } from '../../lib/flow.ts'
import { formatRelative, plural } from '../../lib/format.ts'
import { type ScopeView, foldOtherTeams } from '../../lib/home-scope.ts'
import { type LibraryEcosystem, libraryEcosystems } from '../../lib/libraries.ts'
import { parseRepoKey, repoKey } from '../../lib/repo.ts'
import { pageSettingKeys } from '../../lib/settings-sections.ts'
import type { SortState } from '../../lib/table-sort.ts'
import { upgradePrompt } from '../../lib/upgrade-prompt.ts'
import {
  Count,
  EmptyState,
  ErrorState,
  type FleetColumn,
  FleetTable,
  Page,
  Placeholder,
  SegmentBar,
  SegmentedTabs,
  Select,
  SeverityChip,
  SideSheet,
  type StripCell,
  Tag,
  notify,
  quietActionsOf,
} from '../../ui/index.ts'
import { useRunJob } from '../jobs/RunJobDialog.tsx'
import { useConfigure } from '../settings/SettingsSheet.tsx'
import { useScope } from '../shell/scope.ts'
import { useSession } from '../shell/session.ts'
import { LibraryDetail, type LibraryState } from './LibraryDetail.tsx'

const behindLegend = [
  { tone: 'success', label: 'current major' },
  { tone: 'warning', label: '1 major behind' },
  { tone: 'danger', label: '2+ behind' },
] as const

const columns: readonly FleetColumn<LibraryFleetRow, LibrariesSortKey>[] = [
  {
    id: 'name',
    header: 'Library',
    sortKey: 'name',
    className: 'max-w-[22rem]',
    cell: (row) => (
      <span className="flex flex-wrap items-center gap-2">
        <Link
          to="/supply/libraries/$ecosystem/$"
          params={{ ecosystem: row.ecosystem, _splat: row.name }}
          className="mono truncate font-medium hover:underline"
        >
          {row.name}
        </Link>
        {row.internal ? <Tag tone="accent">internal</Tag> : null}
      </span>
    ),
  },
  {
    id: 'ecosystem',
    header: 'Ecosystem',
    sortKey: 'ecosystem',
    cell: (row) => <Tag mono>{row.ecosystem}</Tag>,
  },
  {
    id: 'versions',
    header: 'Versions in use',
    sortKey: 'versions',
    className: 'min-w-40',
    cell: (row) => (
      <span className="flex flex-col gap-1">
        <SegmentBar
          className="w-36"
          segments={row.versions.map((entry) => ({
            value: entry.repos,
            tone: behindTone(entry.majorsBehind),
            label: `on ${entry.version}`,
          }))}
        />
        <span className="mono text-xs text-muted">{plural(row.versions.length, 'version')}</span>
      </span>
    ),
  },
  {
    id: 'repos',
    header: 'Repos',
    sortKey: 'repos',
    align: 'right',
    cell: (row) => <span className="tabular">{row.usedBy.length}</span>,
  },
  {
    id: 'latest',
    header: 'Latest',
    sortKey: 'latest',
    cell: (row) => <span className="mono">{row.latest ?? '—'}</span>,
  },
  {
    id: 'behind',
    header: 'Behind',
    sortKey: 'behind',
    cell: (row) =>
      row.latest ? (
        <Tag tone={behindTone(row.majorsBehind)}>
          {behindLabel(row.majorsBehind)}
          {row.reposBehind ? ` · ${row.reposBehind}` : ''}
        </Tag>
      ) : (
        <span className="text-dim">—</span>
      ),
  },
  {
    id: 'advisories',
    header: 'Advisories',
    sortKey: 'advisories',
    cell: (row) =>
      row.advisories.count && row.advisories.severity ? (
        <SeverityChip severity={row.advisories.severity} count={row.advisories.count} compact />
      ) : row.advisories.count ? (
        <span className="tabular">{row.advisories.count}</span>
      ) : (
        <span className="text-dim">—</span>
      ),
  },
  {
    id: 'updates',
    header: 'Update MRs',
    sortKey: 'updates',
    cell: (row) =>
      row.renovate === 'none' ? (
        <span className="text-dim">—</span>
      ) : (
        <Tag tone={row.renovate === 'broken' ? 'danger' : 'default'}>
          {row.renovate === 'broken' ? 'broken' : 'open'}
        </Tag>
      ),
  },
]

function downloadCsv(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const newestRead = (table: DependencyTable): string | undefined =>
  table.repos
    .flatMap((entry) => (entry.createdAt ? [entry.createdAt] : []))
    .toSorted()
    .at(-1)

interface TableState {
  segment: DependencyFilter
  ecosystem: string
  query: string
  sort: SortState<LibrariesSortKey>
}

/** The rows a table state shows, in order, and the counts its segments and ecosystems carry. */
function useLibraryRows(
  table: DependencyTable | undefined,
  state: TableState,
  options: { repo?: string; view: ScopeView },
) {
  const { homeGroups } = useScope()
  if (!table) return undefined
  const view = options.repo ? 'all' : options.view
  const scoped = scopeLibraryRows(table.libraries, table.repos, view, homeGroups)
  const inView =
    view === 'mine' ? foldOtherTeams(scoped, homeGroups, (row) => row.groups).mine : scoped
  const filter = {
    query: state.query,
    ecosystem: state.ecosystem,
    filter: state.segment,
    ...(options.repo ? { repo: options.repo } : {}),
  }
  const rows = sortRows(filterRows(scoped, filter), state.sort)
  const counts = filterCounts(inView, filter)
  const ecosystems = libraryEcosystems.filter((entry) =>
    table.libraries.some((row) => row.ecosystem === entry.id),
  )
  return { rows, counts, ecosystems, homeGroups }
}

function Toolbar({
  state,
  onState,
  counts,
  ecosystems,
}: {
  state: TableState
  onState: (next: Partial<TableState>) => void
  counts: ReturnType<typeof filterCounts>
  ecosystems: readonly { id: LibraryEcosystem; label: string }[]
}) {
  return (
    <>
      <SegmentedTabs
        aria-label="Show"
        selected={state.segment}
        onSelect={(id) =>
          onState({ segment: dependencyFilters.find((entry) => entry.id === id)?.id ?? 'all' })
        }
        items={dependencyFilters.map((entry) => ({
          id: entry.id,
          label: (
            <>
              {entry.label} <Count>{counts.segments[entry.id]}</Count>
            </>
          ),
        }))}
      />
      {ecosystems.length > 1 ? (
        <SegmentedTabs
          aria-label="Ecosystem"
          selected={state.ecosystem}
          onSelect={(ecosystem) => onState({ ecosystem })}
          items={[
            { id: '*', label: 'All ecosystems' },
            ...ecosystems.map((entry) => ({
              id: entry.id,
              label: (
                <>
                  {entry.label} <Count>{counts.ecosystems[entry.id]}</Count>
                </>
              ),
            })),
          ]}
        />
      ) : null}
    </>
  )
}

const strip =
  (read: string | undefined, mine: boolean) =>
  (shown: readonly LibraryFleetRow[]): StripCell[] => {
    const totals = libraryTotals(shown)
    return [
      {
        value: totals.libraries,
        label: totals.libraries === 1 ? 'library' : 'libraries',
        caption: `in ${plural(totals.repos, 'repository', 'repositories')}${mine ? ' of my teams' : ''}`,
      },
      { value: totals.behindMajor, label: 'behind a major', tone: 'warning' },
      { value: totals.withAdvisories, label: 'with advisories', tone: 'danger' },
      {
        prefix: 'Update MRs',
        value: totals.renovateOpen,
        label: 'open',
        caption: `· ${totals.renovateBroken} broken`,
        tone: 'info',
      },
      ...(read ? [{ prefix: 'Analysed', value: formatRelative(read), label: '', end: true }] : []),
    ]
  }

const emptyState = (filtered: boolean) => (
  <EmptyState
    icon={<Package />}
    title={filtered ? 'No library matches' : 'No dependencies yet'}
    description={
      filtered
        ? 'Try another segment or name.'
        : 'Run the Dependencies analysis on a repository; its lockfile shows up here.'
    }
  />
)

/**
 * One row per library the readable repositories use: versions in use, latest, how far behind,
 * advisories and update merge requests, scoped to the viewer's team by default. Segments,
 * ecosystem, name filter and sort live in the URL; a row opens the library in a side sheet with
 * Overview, Upgrade and Docs, and **Open as page** shows all its tabs.
 */
export function LibrariesPage() {
  const search: LibrariesSearch = useSearch({ strict: false })
  const navigate = useNavigate()
  const repo = parseRepoKey(search.repo)
  const open = parseLibraryKey(search.library)
  const tab = parseLibraryTab(search.tab, librarySheetTabs)
  const table = useDependencies()
  const { view, setView } = useScope()
  const [sheetState, setSheetState] = useState<LibraryState>({})
  const { configure, sheet: settingsSheet } = useConfigure(
    'Libraries settings',
    pageSettingKeys.dependencies,
  )
  const sheet = useDependency(open)
  const { can } = useSession()
  const run = useRunJob({ analyzer: 'depgraph', label: 'Analyse now', ...(repo ? { repo } : {}) })
  const set = (next: LibrariesSearch) =>
    void navigate({ to: '/supply/libraries', search: next, replace: true })
  const state: TableState = {
    segment: search.segment ?? 'all',
    ecosystem: search.ecosystem ?? '*',
    query: search.q ?? '',
    sort: librariesSort(search),
  }
  const onState = (next: Partial<TableState>) => {
    const merged = { ...state, ...next }
    const { segment: _s, ecosystem: _e, q: _q, sort: _o, dir: _d, ...rest } = search
    set(
      withLibrariesSort(
        {
          ...rest,
          ...(merged.segment !== 'all' ? { segment: merged.segment } : {}),
          ...(merged.ecosystem === 'npm' || merged.ecosystem === 'Go'
            ? { ecosystem: merged.ecosystem }
            : {}),
          ...(merged.query ? { q: merged.query } : {}),
        },
        merged.sort,
      ),
    )
  }
  const goLibrary = (next: { library?: string; tab?: string }) => {
    if (next.library !== search.library) setSheetState({})
    const { library: _l, tab: _t, ...rest } = search
    set({
      ...rest,
      ...(next.library ? { library: next.library } : {}),
      ...(next.library && next.tab && next.tab !== 'overview' ? { tab: next.tab } : {}),
    })
  }
  const sheetDetail = sheet.data
  const sheetTarget = sheetDetail
    ? (sheetDetail.latest ?? upgradeVersions(sheetDetail).to[0])
    : undefined
  const sheetBehind =
    sheetDetail?.usedBy.filter((user) => !sheetTarget || !user.versions.includes(sheetTarget))
      .length ?? 0
  const copyPrompt = async () => {
    if (!sheetDetail) return
    const text = upgradePrompt({
      name: sheetDetail.name,
      ecosystem: sheetDetail.ecosystem,
      ...(sheetTarget ? { to: sheetTarget } : {}),
      repos: sheetDetail.usedBy
        .filter((user) => !sheetTarget || !user.versions.includes(sheetTarget))
        .map((user) => ({ repo: repoKey(user.repo), versions: user.versions })),
    })
    try {
      await navigator.clipboard.writeText(text)
      notify.success('Prompt copied')
    } catch {
      notify.error('Not copied', 'The browser did not allow the clipboard.')
    }
  }
  const sheetQuiet =
    open && sheetDetail
      ? quietActionsOf([
          ...(can('tasks:run')
            ? [
                {
                  label: 'Plan upgrade',
                  icon: Rocket,
                  onPress: () => goLibrary({ library: libraryKey(open), tab: 'upgrade' }),
                },
              ]
            : []),
          { label: 'Copy as prompt', icon: Copy, onPress: () => void copyPrompt() },
        ])
      : undefined

  const data = table.data
  const shown = useLibraryRows(data, state, { view, ...(repo ? { repo: repoKey(repo) } : {}) })
  const keys = shown
    ? (view === 'mine' && !repo
        ? foldOtherTeams(shown.rows, shown.homeGroups, (row) => row.groups).mine
        : shown.rows
      ).map(libraryKey)
    : []
  const step = neighbours(keys, search.library)
  const filtered = Boolean(search.q || search.segment || search.ecosystem)

  return (
    <Page
      crumbs={[{ label: 'Libraries' }]}
      search={{
        value: state.query,
        onChange: (query) => onState({ query }),
        'aria-label': 'Filter libraries',
        placeholder: 'Filter by library',
      }}
      filters={
        data && data.repos.length > 1 ? (
          <Select
            aria-label="Repository"
            className="w-56"
            value={search.repo ?? '*'}
            onChange={(value) => {
              const { repo: _r, ...rest } = search
              set({ ...rest, ...(value !== '*' ? { repo: value } : {}) })
            }}
            options={[
              { id: '*', label: 'All repositories' },
              ...data.repos
                .map((entry) => repoKey(entry.repo))
                .toSorted()
                .map((key) => ({ id: key, label: key })),
            ]}
          />
        ) : undefined
      }
      {...(configure ? { configure } : {})}
      more={[
        {
          label: 'Export CSV',
          icon: Download,
          isDisabled: !shown?.rows.length,
          onAction: () => shown && downloadCsv(toCsv(shown.rows), 'libraries.csv'),
        },
      ]}
      primary={run.action}
    >
      {table.isPending ? (
        <Placeholder className="h-96" />
      ) : table.isError ? (
        <ErrorState error={table.error} />
      ) : shown && data ? (
        <FleetTable<LibraryFleetRow, LibrariesSortKey>
          label="Libraries"
          rows={shown.rows}
          rowKey={libraryKey}
          columns={columns}
          sort={state.sort}
          onSort={(sort) => onState({ sort })}
          {...(repo
            ? {}
            : { scope: { value: view, onChange: setView, homeGroups: shown.homeGroups } })}
          strip={strip(newestRead(data), view === 'mine' && !repo)}
          legend={behindLegend}
          toolbar={
            <Toolbar
              state={state}
              onState={onState}
              counts={shown.counts}
              ecosystems={shown.ecosystems}
            />
          }
          onOpen={(row) => goLibrary({ library: libraryKey(row), tab })}
          noun={{ one: 'library', many: 'libraries' }}
          {...(repo ? { caption: `· used by ${repoKey(repo)}` } : {})}
          empty={emptyState(filtered || data.libraries.length > 0)}
        />
      ) : null}
      {settingsSheet}
      {run.dialog}
      <SideSheet
        open={open !== undefined}
        onClose={() => goLibrary({})}
        id={open?.ecosystem}
        title={open?.name ?? ''}
        {...(step.index >= 0 ? { index: step.index, total: keys.length } : {})}
        {...(step.previous ? { onPrevious: () => goLibrary({ library: step.previous, tab }) } : {})}
        {...(step.next ? { onNext: () => goLibrary({ library: step.next, tab }) } : {})}
        {...(open
          ? {
              openAsPage: {
                to: '/supply/libraries/$ecosystem/$',
                params: { ecosystem: open.ecosystem, _splat: open.name },
                search: tab !== 'overview' ? { tab } : {},
              },
            }
          : {})}
        {...(sheetDetail
          ? {
              progress: {
                segments: sheetDetail.versions.map((version) => ({
                  value: version.repos,
                  tone: behindTone(version.majorsBehind),
                  label: `${version.version} × ${version.repos}`,
                })),
                label: (
                  <span className="mono">
                    {sheetDetail.versions
                      .map((version) => `${version.version} × ${version.repos}`)
                      .join(' · ')}
                  </span>
                ),
              },
            }
          : {})}
        {...(sheetQuiet && { quietActions: sheetQuiet })}
        {...(open && sheetDetail?.internal
          ? {
              more: [
                {
                  label: 'Public API',
                  icon: Braces,
                  href: `/supply/libraries/${open.ecosystem}/${open.name}?tab=api`,
                },
              ],
            }
          : {})}
        tabs={{
          items: librarySheetTabs.map((item) => {
            const badge =
              item.id === 'used-by'
                ? sheetDetail?.usedBy.length
                : item.id === 'upgrade'
                  ? sheetBehind
                  : 0
            return { ...item, ...(badge ? { badge } : {}) }
          }),
          selected: tab,
          onSelect: (next) =>
            open &&
            goLibrary({ library: libraryKey(open), tab: parseLibraryTab(next, librarySheetTabs) }),
          'aria-label': 'Library views',
        }}
      >
        {open ? (
          <LibraryDetail
            key={libraryKey(open)}
            library={open}
            tab={tab}
            state={sheetState}
            onState={setSheetState}
            inSheet
          />
        ) : null}
      </SideSheet>
    </Page>
  )
}

/**
 * The libraries one repository uses with its own versions, for the repository hub: segments,
 * ecosystem and sort as on Libraries, kept on the page; a row opens the library's page with Used
 * by narrowed to the repository.
 */
export function RepoLibraries({ repo }: { repo: RepoRef }) {
  const navigate = useNavigate()
  const table = useDependencies()
  const [state, setState] = useState<TableState>({
    segment: 'all',
    ecosystem: '*',
    query: '',
    sort: null,
  })
  const key = repoKey(repo)
  const shown = useLibraryRows(table.data, state, { repo: key, view: 'all' })
  if (table.isPending) return <Placeholder className="h-64" />
  if (table.isError) return <ErrorState error={table.error} />
  if (!shown) return null
  return (
    <FleetTable<LibraryFleetRow, LibrariesSortKey>
      label={`Libraries ${key} uses`}
      rows={shown.rows}
      rowKey={libraryKey}
      columns={columns}
      sort={state.sort}
      onSort={(sort) => setState({ ...state, sort })}
      strip={strip(undefined, false)}
      legend={behindLegend}
      toolbar={
        <Toolbar
          state={state}
          onState={(next) => setState({ ...state, ...next })}
          counts={shown.counts}
          ecosystems={shown.ecosystems}
        />
      }
      onOpen={(row) =>
        void navigate({
          to: '/supply/libraries/$ecosystem/$',
          params: { ecosystem: row.ecosystem, _splat: row.name },
          search: { tab: 'used-by', repo: key },
        })
      }
      noun={{ one: 'library', many: 'libraries' }}
      empty={emptyState(state.segment !== 'all' || state.ecosystem !== '*')}
    />
  )
}
