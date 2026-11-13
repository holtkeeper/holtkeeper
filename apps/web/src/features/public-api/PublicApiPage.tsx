import type {
  PublicApiFacetCount,
  PublicApiPackageSummary,
  PublicApiSymbol,
  PublicApiSymbolHit,
  RepoRef,
} from '@holtkeeper/api'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { GitCompare, Library, RefreshCw, Search, Users } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import {
  usePublicApiPackages,
  usePublicApiRescan,
  usePublicApiSearch,
  usePublicApiSymbol,
} from '../../api/queries.ts'
import { neighbours } from '../../lib/flow.ts'
import { formatDate, formatRef, formatRelative, plural } from '../../lib/format.ts'
import {
  type PublicApiPane,
  type PublicApiSearch,
  type PublicApiTab,
  catalogTotals,
  changeLabels,
  docSummary,
  documentedShare,
  documentedTone,
  filterHits,
  hitCounts,
  matchLabels,
  openedSymbol,
  parseDocTags,
  publicApiTab,
  symbolKey,
  symbolKinds,
} from '../../lib/public-api.ts'
import { repoKey, repoSplat } from '../../lib/repo.ts'
import { pageSettingKeys } from '../../lib/settings-sections.ts'
import { useDebounced } from '../../lib/use-debounced.ts'
import {
  Checkbox,
  CopyButton,
  Count,
  EmptyState,
  ErrorState,
  Kbd,
  KeyValue,
  Legend,
  ListFooter,
  Markdown,
  type MoreMenuItem,
  Notice,
  Page,
  Placeholder,
  SearchInput,
  SegmentedTabs,
  Select,
  SideSheet,
  Strip,
  Table,
  Tag,
  Td,
  Th,
  notify,
} from '../../ui/index.ts'
import { useBackfillReleases } from '../analyses/BackfillReleases.tsx'
import { useRunJob } from '../jobs/RunJobDialog.tsx'
import { useConfigure } from '../settings/SettingsSheet.tsx'
import { useSession } from '../shell/session.ts'

const hitLimit = 100

const tabCount = (value: number | undefined) =>
  value ? <span className="tabular text-muted">{value}</span> : null

const matches = ['exact', 'prefix', 'part', 'doc'] as const

const kindLabel = (kind: string) =>
  kind === 'variable' ? 'constant' : kind === 'reexport' ? 're-export' : kind

/** The Public API page: the catalog of packages and symbol search with facets and a symbol sheet. */
export function PublicApiPage() {
  const search = useSearch({ from: '/app/supply/public-api' })
  const navigate = useNavigate()
  const { can } = useSession()
  const rescan = usePublicApiRescan()
  const backfill = useBackfillReleases('api-surface')
  const { configure, sheet } = useConfigure('Public API settings', pageSettingKeys['public-api'])
  const run = useRunJob({ analyzer: 'api-surface', label: 'Analyse now' })
  const setSearch = (next: PublicApiSearch) =>
    void navigate({ to: '/supply/public-api', search: next, replace: true })
  const q = useDebounced(search.q ?? '', 300).trim()
  const tab = publicApiTab(search)
  const more: MoreMenuItem[] = [
    ...(can('analyses:run')
      ? [
          {
            label: 'Reread records',
            icon: RefreshCw,
            isDisabled: rescan.isPending,
            onAction: () =>
              rescan.mutate(undefined, {
                onSuccess: () => notify.success('Records reread'),
                onError: (error) => notify.error('Not reread', messageOf(error)),
              }),
          },
        ]
      : []),
    ...(backfill.item ? [backfill.item] : []),
  ]
  return (
    <Page
      crumbs={[{ label: 'Public API' }]}
      description="What every package exports, its doc comments and how each export changed between versions"
      search={{
        value: search.q ?? '',
        onChange: (text) => {
          const { q: _q, symbol: _symbol, pane: _pane, ...rest } = search
          setSearch(text ? { ...rest, q: text } : rest)
        },
        'aria-label': tab === 'search' ? 'Search exports' : 'Filter packages',
        placeholder:
          tab === 'search' ? 'Name or words from its docs, e.g. createWidget' : 'Package name',
      }}
      {...(configure ? { configure } : {})}
      more={more}
      primary={run.action}
    >
      <ViewTabs
        tab={tab}
        search={{ ...search, q }}
        onTab={(next: PublicApiTab) => {
          const { symbol: _symbol, pane: _pane, ...rest } = search
          setSearch({ ...rest, tab: next })
        }}
      />
      {tab === 'search' ? (
        <SymbolSearch search={search} q={q} setSearch={setSearch} />
      ) : (
        <Catalog search={{ ...search, q }} />
      )}
      {backfill.dialog}
      {sheet}
      {run.dialog}
    </Page>
  )
}

function ViewTabs({
  tab,
  search,
  onTab,
}: {
  tab: PublicApiTab
  search: PublicApiSearch
  onTab: (tab: PublicApiTab) => void
}) {
  const packages = usePublicApiPackages()
  const hits = usePublicApiSearch(searchQuery(search), hitLimit)
  return (
    <SegmentedTabs
      aria-label="Public API views"
      selected={tab}
      onSelect={(id) => onTab(id === 'search' ? 'search' : 'packages')}
      className="self-start"
      items={[
        {
          id: 'packages',
          label: (
            <span className="inline-flex items-center gap-1.5">
              Packages {tabCount(packages.data?.packages.length)}
            </span>
          ),
          icon: Library,
        },
        {
          id: 'search',
          label: (
            <span className="inline-flex items-center gap-1.5">
              Symbol search{' '}
              {search.q
                ? tabCount(hits.data ? hits.data.hits.length + hits.data.more : undefined)
                : null}
            </span>
          ),
          icon: Search,
        },
      ]}
    />
  )
}

const searchQuery = (search: PublicApiSearch) => ({
  q: search.q ?? '',
  ...(search.package ? { package: search.package } : {}),
  ...(search.repo ? { repo: search.repo } : {}),
  ...(search.subpath ? { subpath: search.subpath } : {}),
  ...(search.kind ? { kind: search.kind } : {}),
  ...(search.match ? { match: search.match } : {}),
})

const documentedLegend = [
  { tone: 'success', label: '80% or more' },
  { tone: 'warning', label: '40 to 79%' },
  { tone: 'danger', label: 'under 40%' },
] as const

function Catalog({
  search,
  repo,
}: {
  search: Pick<PublicApiSearch, 'q' | 'repo' | 'package'>
  repo?: string
}) {
  const packages = usePublicApiPackages(search.q || undefined)
  if (packages.isPending) return <Placeholder className="h-96" />
  if (packages.isError) return <ErrorState error={packages.error} />
  const narrowTo = repo ?? search.repo
  const list = packages.data.packages.filter(
    (pkg) =>
      (!narrowTo || repoKey(pkg.repo) === narrowTo) &&
      (!search.package || pkg.name === search.package),
  )
  const totals = catalogTotals(list)
  return (
    <section className="rounded-xl border border-line bg-panel">
      <div className="flex flex-col gap-0.5 px-3.5 pt-3 pb-2">
        <h2 className="text-[13px] font-semibold">Packages</h2>
        <p className="text-xs text-muted">
          Newest record of each package
          {packages.data.indexedAt
            ? `; all records reread ${formatRelative(packages.data.indexedAt)}`
            : ''}
        </p>
      </div>
      <Strip
        label="Catalog summary"
        cells={[
          {
            value: totals.packages,
            label: `${totals.packages === 1 ? 'package' : 'packages'} in ${plural(totals.repos, 'repository', 'repositories')}`,
          },
          { value: totals.exports.toLocaleString('en-US'), label: 'exports' },
          ...(totals.documented !== undefined
            ? [
                {
                  value: `${totals.documented}%`,
                  label: 'documented',
                  tone: documentedTone(totals.documented),
                },
              ]
            : []),
          {
            value: totals.versions,
            label: 'versions on record',
            caption: '· releases plus default branches',
          },
        ]}
      />
      <Legend items={documentedLegend} label="Documented share" className="px-3.5 py-2" />
      {list.length ? (
        <Table label="Packages">
          <thead>
            <tr>
              <Th>Package</Th>
              <Th>Version</Th>
              <Th>Repository</Th>
              <Th align="right">Exports</Th>
              <Th>Documented</Th>
              <Th align="right">Versions</Th>
              <Th>Analysed</Th>
            </tr>
          </thead>
          <tbody>
            {list.map((pkg) => (
              <PackageRow key={`${repoKey(pkg.repo)} ${pkg.name}`} pkg={pkg} />
            ))}
          </tbody>
        </Table>
      ) : (
        <EmptyState
          icon={<Library />}
          title={search.q || narrowTo ? 'No package matches' : 'No package indexed yet'}
          description={
            search.q || narrowTo
              ? 'Try part of the name, or clear the repository.'
              : 'Run the api-surface analyzer on a repository, or analyse past releases to fill in the version history.'
          }
        />
      )}
    </section>
  )
}

function DocumentedBar({ documented, exports }: { documented: number; exports: number }) {
  const share = documentedShare(documented, exports)
  if (share === undefined) return <span className="text-dim">—</span>
  const tone = documentedTone(share)
  return (
    <span className="inline-flex items-center gap-2" title={`${share}% of exports documented`}>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-raise">
        <span
          className="block h-full rounded-full"
          style={{
            width: `${share}%`,
            background:
              tone === 'success' ? 'var(--ok)' : tone === 'warning' ? 'var(--warn)' : 'var(--bad)',
          }}
        />
      </span>
      <span className="tabular w-9 text-right">{share}%</span>
    </span>
  )
}

function PackageRow({ pkg }: { pkg: PublicApiPackageSummary }) {
  return (
    <tr>
      <Td className="max-w-[22rem]">
        <div className="flex flex-wrap items-center gap-1.5">
          <Link
            to="/supply/libraries/$ecosystem/$"
            params={{ ecosystem: pkg.ecosystem ?? 'npm', _splat: pkg.name }}
            search={{ tab: 'api', repo: repoKey(pkg.repo) }}
            className="mono font-medium hover:underline"
          >
            {pkg.name}
          </Link>
          {pkg.ecosystem === 'Go' ? <Tag tone="accent">Go</Tag> : null}
          {pkg.private ? <Tag>{pkg.ecosystem === 'Go' ? 'internal' : 'private'}</Tag> : null}
          {pkg.removed ? (
            <Tag
              tone="danger"
              title={`Not on the default branch since ${formatDate(pkg.removed.at)}`}
            >
              Removed
            </Tag>
          ) : null}
        </div>
        {pkg.description ? (
          <div className="mt-0.5 truncate text-xs text-muted">{pkg.description}</div>
        ) : null}
      </Td>
      <Td className="mono">{pkg.version ?? '—'}</Td>
      <Td>
        <span className="mono">{pkg.repo.path}</span>
        {pkg.dir !== '.' ? <span className="mono ml-1 text-xs text-dim">/{pkg.dir}</span> : null}
      </Td>
      <Td align="right" className="tabular">
        {pkg.exports.toLocaleString('en-US')}
      </Td>
      <Td>
        <DocumentedBar documented={pkg.documented} exports={pkg.exports} />
      </Td>
      <Td align="right" className="tabular">
        {pkg.versions}
      </Td>
      <Td className="whitespace-nowrap text-muted">
        <span className="mono text-xs" title={pkg.ref ?? 'default branch'}>
          {pkg.ref ? formatRef(pkg.ref) : 'branch'}
        </span>{' '}
        · {formatRelative(pkg.analyzedAt)}
      </Td>
    </tr>
  )
}

function Facet({
  title,
  options,
  value,
  onChange,
  label = (option) => option,
  hidden,
}: {
  title: string
  options: readonly PublicApiFacetCount[]
  value: string | undefined
  onChange: (value: string | undefined) => void
  label?: (value: string) => ReactNode
  /** Quiet line under the options, e.g. how many packages have no match. */
  hidden?: ReactNode
}) {
  if (!options.length) return null
  return (
    <fieldset className="flex flex-col gap-0.5">
      <legend className="mb-1 text-[11.5px] font-medium text-muted">{title}</legend>
      {options.map((option) => {
        const on = value === option.value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? undefined : option.value)}
            className={`flex items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] hover:bg-raise ${on ? 'bg-raise text-foreground shadow-[inset_0_0_0_1px_var(--color-line-strong)]' : 'text-muted'}`}
          >
            <span className="min-w-0 flex-1 truncate">{label(option.value)}</span>
            <span className="tabular text-[11px]">{option.count}</span>
          </button>
        )
      })}
      {hidden ? <span className="px-2 pt-0.5 text-[11px] text-dim">{hidden}</span> : null}
    </fieldset>
  )
}

function SymbolSearch({
  search,
  q,
  setSearch,
  repo,
}: {
  search: PublicApiSearch
  /** The search text once typing settles; `search.q` follows every key. */
  q: string
  setSearch: (next: PublicApiSearch) => void
  /** Narrows everything to one repository, as the repository hub does. */
  repo?: string
}) {
  const query = searchQuery({ ...search, q, ...(repo ? { repo } : {}) })
  const results = usePublicApiSearch(query, hitLimit)
  const packages = usePublicApiPackages()
  if (!query.q)
    return (
      <EmptyState
        icon={<Search />}
        title="Search the catalog"
        description="Type a function, class or type name, or words from its doc comment. Exact names come first, then prefixes, parts of names and doc text."
      />
    )
  if (results.isPending) return <Placeholder className="h-96" />
  if (results.isError) return <ErrorState error={results.error} />
  const { facets } = results.data
  const counts = hitCounts(results.data.hits)
  const hits = filterHits(
    results.data.hits,
    {
      ...(search.deprecated ? { deprecated: true } : {}),
      ...(search.removed ? { removed: true } : {}),
      ...(search.ref ? { ref: search.ref } : {}),
    },
    search.sort,
  )
  const set = (patch: Partial<PublicApiSearch>) => {
    const { symbol: _symbol, pane: _pane, ...rest } = search
    setSearch({ ...rest, ...patch })
  }
  const keys = hits.map(symbolKey)
  const step = neighbours(keys, search.symbol)
  const openHit = (key: string | undefined) => {
    if (!key) return
    const { pane, ...rest } = search
    setSearch({ ...rest, symbol: key, ...(pane ? { pane } : {}) })
  }
  const openedHit = step.index >= 0 ? hits[step.index] : undefined
  const withoutMatch = Math.max(0, (packages.data?.packages.length ?? 0) - facets.packages.length)
  const matchFacet = matches.flatMap((value) => {
    const found = facets.matches?.find((entry) => entry.value === value)
    return found ? [found] : []
  })
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <aside aria-label="Narrow the search" className="flex shrink-0 flex-col gap-4 lg:w-56">
        {repo ? null : (
          <Facet
            title="Package"
            options={facets.packages}
            value={search.package}
            onChange={(value) => set({ package: value })}
            label={(value) => <span className="mono">{value}</span>}
            {...(withoutMatch
              ? { hidden: `${plural(withoutMatch, 'package')} without a match` }
              : {})}
          />
        )}
        <Facet
          title="Entry point"
          options={facets.subpaths ?? []}
          value={search.subpath}
          onChange={(value) => set({ subpath: value })}
          label={(value) => (
            <span className="mono">{value === '.' ? '.' : value.replace(/^\./, '')}</span>
          )}
        />
        <Facet
          title="Kind"
          options={facets.kinds}
          value={search.kind}
          onChange={(value) =>
            set({ kind: symbolKinds.find((entry) => entry.kind === value)?.kind })
          }
          label={kindLabel}
        />
        <Facet
          title="Version"
          options={[
            { value: 'release', count: counts.release },
            { value: 'head', count: counts.head },
          ].filter((entry) => entry.count > 0)}
          value={search.ref}
          onChange={(value) =>
            set({ ref: value === 'release' || value === 'head' ? value : undefined })
          }
          label={(value) => (value === 'release' ? 'Newest release' : 'Default branch')}
        />
        <div className="flex flex-col gap-1.5">
          <Checkbox
            label={
              <span className="text-[12.5px]">
                Include deprecated <span className="tabular text-dim">{counts.deprecated}</span>
              </span>
            }
            isSelected={search.deprecated === true}
            onChange={(on) => set({ deprecated: on ? true : undefined })}
          />
          <Checkbox
            label={
              <span className="text-[12.5px]">
                Include removed packages <span className="tabular text-dim">{counts.removed}</span>
              </span>
            }
            isSelected={search.removed === true}
            onChange={(on) => set({ removed: on ? true : undefined })}
          />
        </div>
        <Facet
          title="Match"
          options={matchFacet}
          value={search.match}
          onChange={(value) => set({ match: matches.find((entry) => entry === value) })}
          label={(value) => matchLabels[matches.find((entry) => entry === value) ?? 'doc']}
        />
      </aside>
      <section className="min-w-0 flex-1 rounded-xl border border-line bg-panel">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2.5 text-xs text-muted">
          <span>
            <b className="font-semibold text-foreground">{hits.length}</b>{' '}
            {hits.length === 1 ? 'export matches' : 'exports match'} in{' '}
            {plural(new Set(hits.map((hit) => hit.package)).size, 'package')}
          </span>
          <span>· exact names first, then prefixes, parts of names and doc text</span>
          <span className="flex-1" />
          <Select
            aria-label="Sort"
            className="w-40"
            value={search.sort ?? 'match'}
            onChange={(value) =>
              set({ sort: value === 'name' || value === 'package' ? value : undefined })
            }
            options={[
              { id: 'match', label: 'Best match' },
              { id: 'name', label: 'Name' },
              { id: 'package', label: 'Package' },
            ]}
          />
        </div>
        {hits.length ? (
          <Table label="Matching exports">
            <thead>
              <tr>
                <Th>Symbol</Th>
                <Th>Kind</Th>
                <Th>Package</Th>
                <Th>Version</Th>
                <Th>Signature</Th>
                <Th>Doc</Th>
              </tr>
            </thead>
            <tbody>
              {hits.map((hit) => (
                <HitRow
                  key={`${repoKey(hit.repo)} ${symbolKey(hit)}`}
                  hit={hit}
                  selected={search.symbol === symbolKey(hit)}
                  onOpen={() => openHit(symbolKey(hit))}
                />
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState
            title="Nothing exported matches"
            description="Try a shorter part of the name, or include deprecated symbols and removed packages."
          />
        )}
        <ListFooter
          shown={hits.length}
          total={hits.length + results.data.more}
          noun="matches"
          {...(results.data.more
            ? { caption: '· narrow the query or a facet to see the rest' }
            : {})}
          hints={
            <>
              Navigate <Kbd>J</Kbd> <Kbd>K</Kbd> in the sheet
            </>
          }
          className="border-t border-line"
        />
      </section>
      <SymbolSheet
        symbolKey={search.symbol}
        hit={openedHit}
        repo={openedHit ? repoKey(openedHit.repo) : (repo ?? search.repo)}
        version={search.version}
        pane={search.pane ?? 'declaration'}
        onPane={(pane) => setSearch({ ...search, pane })}
        index={step.index}
        total={hits.length}
        onClose={() => {
          const { symbol: _symbol, pane: _pane, ...rest } = search
          setSearch(rest)
        }}
        {...(step.previous ? { onPrevious: () => openHit(step.previous) } : {})}
        {...(step.next ? { onNext: () => openHit(step.next) } : {})}
      />
    </div>
  )
}

function HitRow({
  hit,
  selected,
  onOpen,
}: {
  hit: PublicApiSymbolHit
  selected: boolean
  onOpen: () => void
}) {
  const signature = hit.symbol.signature.split('\n')[0] ?? ''
  return (
    <tr
      className={`hover:bg-raise ${selected ? '[&>td]:bg-raise [&>td:first-child]:shadow-[inset_2px_0_var(--fg)]' : ''}`}
    >
      <Td>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onOpen}
            aria-pressed={selected}
            className="mono font-medium hover:underline"
          >
            {hit.symbol.name}
          </button>
          <Tag tone={hit.match === 'exact' ? 'accent' : 'default'}>{matchLabels[hit.match]}</Tag>
          {hit.deprecated ? <Tag tone="warning">Deprecated</Tag> : null}
          {hit.removed ? <Tag tone="danger">Removed</Tag> : null}
        </div>
      </Td>
      <Td className="text-muted">{kindLabel(hit.symbol.kind)}</Td>
      <Td>
        <span className="mono">{hit.package}</span>
        {hit.subpath !== '.' ? (
          <span className="mono ml-1 text-dim">{hit.subpath.replace(/^\./, '')}</span>
        ) : null}
      </Td>
      <Td className="mono">{hit.version ?? (hit.ref ? formatRef(hit.ref) : 'branch')}</Td>
      <Td className="mono max-w-[22rem] truncate text-xs text-muted">
        <span title={signature}>{signature}</span>
      </Td>
      <Td className="max-w-[20rem] truncate text-xs text-muted">{docSummary(hit.symbol.doc)}</Td>
    </tr>
  )
}

const libraryLink = (
  pkg: string,
  ecosystem: 'npm' | 'Go',
  search: { tab: string; export?: string; repo?: string },
) =>
  ({
    to: '/supply/libraries/$ecosystem/$',
    params: { ecosystem, _splat: pkg },
    search,
  }) as const

/** One exported symbol: its declaration with the doc comment's tags, where it lives, and its history. */
function SymbolSheet({
  symbolKey: key,
  hit,
  repo,
  version,
  pane,
  onPane,
  index,
  total,
  onClose,
  onPrevious,
  onNext,
}: {
  symbolKey: string | undefined
  hit: PublicApiSymbolHit | undefined
  repo: string | undefined
  version: string | undefined
  pane: PublicApiPane
  onPane: (pane: PublicApiPane) => void
  index: number
  total: number
  onClose: () => void
  onPrevious?: () => void
  onNext?: () => void
}) {
  const navigate = useNavigate()
  const parsed = openedSymbol(key, hit)
  const detail = usePublicApiSymbol(
    parsed
      ? {
          package: parsed.package,
          name: parsed.name,
          subpath: parsed.subpath,
          ...(repo ? { repo } : {}),
          ...(version ? { version } : {}),
          limit: 20,
        }
      : undefined,
  )
  const data = detail.data
  const kind = data?.symbol.kind ?? hit?.symbol.kind
  const changes = data?.history.changes ?? []
  return (
    <SideSheet
      open={parsed !== undefined}
      onClose={onClose}
      id={kind ? kindLabel(kind) : undefined}
      title={<span className="mono">{parsed?.name ?? ''}</span>}
      {...(index >= 0 ? { index, total } : {})}
      {...(onPrevious ? { onPrevious } : {})}
      {...(onNext ? { onNext } : {})}
      {...(parsed
        ? {
            quietActions: [
              {
                label: 'Find usages',
                icon: Users,
                onPress: () =>
                  void navigate(
                    libraryLink(parsed.package, parsed.ecosystem, {
                      tab: 'used-by',
                      export: parsed.name,
                      ...(repo ? { repo } : {}),
                    }),
                  ),
              },
              {
                label: 'Compare versions',
                icon: GitCompare,
                onPress: () =>
                  void navigate(
                    libraryLink(parsed.package, parsed.ecosystem, {
                      tab: 'changes',
                      ...(repo ? { repo } : {}),
                    }),
                  ),
              },
            ] as const,
          }
        : {})}
      tabs={{
        'aria-label': 'Symbol views',
        selected: pane,
        onSelect: (id) => onPane(id === 'history' ? 'history' : 'declaration'),
        items: [
          { id: 'declaration', label: 'Declaration' },
          {
            id: 'history',
            label: 'History',
            ...(changes.length ? { badge: <Count>{changes.length}</Count> } : {}),
          },
        ],
      }}
    >
      {detail.isPending ? (
        <Placeholder className="h-64" />
      ) : detail.isError ? (
        <ErrorState error={detail.error} />
      ) : data ? (
        pane === 'history' ? (
          <SymbolHistory data={data} />
        ) : (
          <Declaration data={data} />
        )
      ) : null}
    </SideSheet>
  )
}

function Declaration({ data }: { data: PublicApiSymbol }) {
  const { symbol } = data
  const tags = parseDocTags(symbol.doc)
  const deprecated = symbol.deprecated ?? tags.deprecated
  const go = data.ecosystem === 'Go'
  const importLine = go
    ? `import "${data.importPath}"`
    : symbol.kind === 'reexport'
      ? undefined
      : `import ${symbol.name === 'default' ? 'value' : `{ ${symbol.name} }`} from '${data.importPath}'`
  const fence = go ? 'go' : 'ts'
  const examples = tags.examples.map((code) =>
    code.startsWith('```') ? code : `\`\`\`${fence}\n${code}\n\`\`\``,
  )
  return (
    <div className="flex flex-col gap-4">
      <p className="mono text-xs text-muted">
        {data.package} {data.version ?? ''} · {symbol.file}:{symbol.line}
      </p>
      {data.removed ? (
        <Notice tone="danger" title="Removed from the repository">
          {repoKey(data.repo)} has not had this package on its default branch since{' '}
          {formatDate(data.removed.at)}; avoid it in new code.
          {data.removed.renamedTo ? ` Probably renamed to ${data.removed.renamedTo}.` : ''}
        </Notice>
      ) : null}
      {deprecated !== undefined ? (
        <Notice tone="warning" title="Deprecated">
          {deprecated ? <Markdown text={deprecated} /> : null}
        </Notice>
      ) : null}
      {importLine ? (
        <div className="flex items-center gap-2">
          <code className="mono min-w-0 flex-1 truncate rounded-md border border-line bg-raise px-2 py-1 text-xs">
            {importLine}
          </code>
          <CopyButton text={() => importLine} variant="ghost">
            Copy import
          </CopyButton>
        </div>
      ) : null}
      <section className="flex flex-col gap-2">
        <h3 className="text-[11.5px] font-medium text-muted">
          Full declaration · <span className="mono">{data.version ?? 'branch'}</span>
        </h3>
        <pre className="mono overflow-x-auto rounded-lg border border-line bg-raise px-3 py-2 text-[12px] leading-relaxed">
          {symbol.signature}
        </pre>
      </section>
      {symbol.doc ? (
        <section className="flex flex-col gap-2.5">
          <h3 className="text-[11.5px] font-medium text-muted">Doc comment</h3>
          {tags.summary ? <Markdown text={tags.summary} className="text-[12.5px]" /> : null}
          <KeyValue
            rows={[
              ...tags.typeParams.map((param) => ({
                label: <span className="mono">{`<${param.name}>`}</span>,
                value: <Markdown text={param.text || '—'} className="text-[12.5px]" />,
              })),
              ...tags.params.map((param) => ({
                label: <span className="mono">{param.name}</span>,
                value: <Markdown text={param.text || '—'} className="text-[12.5px]" />,
              })),
              {
                label: 'Returns',
                value: tags.returns ? (
                  <Markdown text={tags.returns} className="text-[12.5px]" />
                ) : undefined,
              },
              ...tags.throws.map((text) => ({
                label: 'Throws',
                value: <Markdown text={text} className="text-[12.5px]" />,
              })),
              {
                label: 'Since',
                value: tags.since ? <span className="mono">{tags.since}</span> : undefined,
              },
              ...tags.see.map((text) => ({
                label: 'See',
                value: <Markdown text={text} className="text-[12.5px]" />,
              })),
              ...tags.other.map((entry) => ({
                label: entry.tag,
                value: <Markdown text={entry.text || '—'} className="text-[12.5px]" />,
              })),
            ]}
          />
          {examples.map((code, position) => (
            <div key={position} className="flex flex-col gap-1">
              <span className="text-[11.5px] font-medium text-muted">Example</span>
              <Markdown text={code} className="text-[12.5px]" />
            </div>
          ))}
        </section>
      ) : (
        <p className="text-[12.5px] text-muted">No doc comment.</p>
      )}
      <section className="flex flex-col gap-2.5 border-t border-line pt-3.5">
        <h3 className="text-[11.5px] font-medium text-muted">Where</h3>
        <KeyValue
          rows={[
            {
              label: 'Entry point',
              value: (
                <>
                  <span className="mono">{data.subpath}</span>
                  {data.alsoIn.length ? (
                    <span className="text-muted">
                      also in <span className="mono">{data.alsoIn.join(', ')}</span>
                    </span>
                  ) : null}
                </>
              ),
            },
            {
              label: 'Repository',
              value: <RepoName repo={data.repo} />,
            },
            {
              label: 'Version',
              value: (
                <span className="mono">
                  {data.version ?? '—'} · {data.ref ? formatRef(data.ref) : 'default branch'}
                </span>
              ),
            },
            { label: 'Analysed', value: formatRelative(data.analyzedAt) },
          ]}
        />
      </section>
    </div>
  )
}

function RepoName({ repo }: { repo: RepoRef }) {
  return (
    <Link
      to="/repos/$"
      params={{ _splat: repoSplat(repo) }}
      search={{ tab: 'supply', section: 'public-api' }}
      className="mono hover:underline"
    >
      {repo.path}
    </Link>
  )
}

function SymbolHistory({ data }: { data: PublicApiSymbol }) {
  const { changes, versions, capped } = data.history
  if (!changes.length)
    return (
      <EmptyState
        title="No change on record"
        description={`The declaration is the same in all ${plural(versions, 'recorded version')}. Analyse past releases to look further back.`}
      />
    )
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted">
        Versions where it changed · {plural(versions, 'version')} compared
        {capped ? ', older ones left out' : ''}
      </p>
      <ol className="flex flex-col gap-3">
        {changes.map((change) => (
          <li
            key={`${change.version} ${change.change}`}
            className="flex flex-col gap-1.5 border-b border-line pb-3 last:border-b-0"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="mono font-medium">{change.version}</span>
              <Tag tone={changeLabels[change.change].tone} dot>
                {changeLabels[change.change].label}
              </Tag>
              {change.ref &&
              change.ref !== change.version &&
              change.ref !== `v${change.version}` ? (
                <span className="mono text-xs text-dim">{formatRef(change.ref)}</span>
              ) : null}
              <span className="ml-auto text-xs text-muted">{formatDate(change.analyzedAt)}</span>
            </div>
            {change.before || change.after ? (
              <pre className="mono overflow-x-auto rounded-lg border border-line bg-raise px-3 py-2 text-[12px] leading-relaxed">
                {change.before
                  ? change.before.split('\n').map((line, at) => (
                      <span key={`b${at}`} className="block text-[var(--bad)]">
                        - {line}
                      </span>
                    ))
                  : null}
                {change.after
                  ? change.after.split('\n').map((line, at) => (
                      <span
                        key={`a${at}`}
                        className={`block ${change.before ? 'text-[var(--ok)]' : ''}`}
                      >
                        {change.before ? '+ ' : ''}
                        {line}
                      </span>
                    ))
                  : null}
              </pre>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  )
}

/**
 * The public API one repository publishes, for its hub: its packages, each linking to its
 * library page, and symbol search narrowed to the repository with the same symbol sheet.
 */
export function RepoPublicApi({ repo }: { repo: RepoRef }) {
  const [search, setSearch] = useState<PublicApiSearch>({})
  const q = useDebounced(search.q ?? '', 300).trim()
  const key = repoKey(repo)
  return (
    <div className="flex flex-col gap-4">
      <Catalog search={{}} repo={key} />
      <section className="flex flex-col gap-3">
        <SearchInput
          aria-label="Search this repository's exports"
          placeholder="Search exports of this repository"
          value={search.q ?? ''}
          onChange={(text) => setSearch(text ? { q: text } : {})}
          className="w-80"
        />
        {q ? <SymbolSearch search={search} q={q} setSearch={setSearch} repo={key} /> : null}
      </section>
    </div>
  )
}
