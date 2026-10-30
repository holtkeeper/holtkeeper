import { type Finding, emptySeverities } from '@holtkeeper/api'
import {
  type ColumnFiltersState,
  type FilterFn,
  type SortFn,
  type SortingState,
  columnFilteringFeature,
  createColumnHelper,
  createFilteredRowModel,
  createSortedRowModel,
  globalFilteringFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  ExternalLink,
  FileCode2,
  FilterX,
  PackageOpen,
  SearchX,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'

import {
  type FindingRow,
  type LanguageGroup,
  facets,
  firstFix,
  groupFindings,
  matchesSearch,
  toRows,
} from '../../lib/findings.ts'
import { plural } from '../../lib/format.ts'
import { severities, severityLabel, severityRank } from '../../lib/severity.ts'
import {
  Button,
  EmptyState,
  Kbd,
  MultiToggle,
  SearchInput,
  Select,
  SeverityChip,
  Tooltip,
  severityBg,
  languageColor,
} from '../../ui/index.ts'

const features = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric },
})

type Features = typeof features

const inSet: FilterFn<Features, FindingRow> = (row, columnId, value: string[]) =>
  value.length === 0 || value.includes(String(row.getValue(columnId)))

const bySeverity: SortFn<Features, FindingRow> = (a, b) =>
  severityRank(a.original.finding.severity) - severityRank(b.original.finding.severity) ||
  a.original.finding.package.name.localeCompare(b.original.finding.package.name)

const search: FilterFn<Features, FindingRow> = (row, _columnId, value: string) =>
  matchesSearch(row.original, value)

const helper = createColumnHelper<Features, FindingRow>()
const columns = helper.columns([
  helper.accessor((row) => row.finding.severity, {
    id: 'severity',
    filterFn: inSet,
    sortFn: bySeverity,
  }),
  helper.accessor((row) => row.info.language, { id: 'language', filterFn: inSet }),
  helper.accessor((row) => row.info.label, { id: 'tool', filterFn: inSet }),
  helper.accessor((row) => row.finding.package.name, { id: 'package', sortFn: 'alphanumeric' }),
  helper.accessor((row) => row.finding.id, { id: 'advisory', sortFn: 'alphanumeric' }),
  helper.accessor((row) => row.finding.source, { id: 'source', sortFn: 'alphanumeric' }),
])

const sortOptions = [
  { id: 'severity', label: 'Severity' },
  { id: 'package', label: 'Package' },
  { id: 'advisory', label: 'Advisory' },
  { id: 'source', label: 'Source file' },
]

function filterValue(filters: ColumnFiltersState, id: string): string[] {
  const value: unknown = filters.find((f) => f.id === id)?.value
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function setFilter(filters: ColumnFiltersState, id: string, value: string[]): ColumnFiltersState {
  const rest = filters.filter((f) => f.id !== id)
  return value.length ? [...rest, { id, value }] : rest
}

/** Active findings with filters, search and sort, grouped Language → tool → file → package. */
export function FindingsExplorer({ findings }: { findings: readonly Finding[] }) {
  const data = useMemo(() => toRows(findings), [findings])
  const { languages, tools } = useMemo(() => facets(data), [data])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = useState('')
  const [sorting, setSorting] = useState<SortingState>([{ id: 'severity', desc: false }])
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (event.key !== '/' || target?.closest('input, textarea, [contenteditable="true"]')) return
      event.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const table = useTable({
    features,
    columns,
    data,
    state: { columnFilters, globalFilter, sorting },
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onSortingChange: setSorting,
    globalFilterFn: search,
    getColumnCanGlobalFilter: (column) => column.id === 'package',
    getRowId: (row) => row.key,
  })

  const rows = table.getRowModel().rows.map((row) => row.original)
  const groups = groupFindings(rows)
  const sort = sorting[0] ?? { id: 'severity', desc: false }
  const filtered = columnFilters.length > 0 || globalFilter.trim() !== ''

  if (data.length === 0) {
    return (
      <EmptyState
        icon={<PackageOpen />}
        title="No active findings"
        description="Everything found is fixed or allowlisted."
      />
    )
  }

  const counts = emptySeverities()
  for (const row of data) counts[row.finding.severity]++

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-3 shadow-surface">
        <div className="flex flex-wrap items-center gap-3">
          <SearchInput
            aria-label="Search findings"
            placeholder="Search package, advisory, CVE, file…"
            value={globalFilter}
            onChange={setGlobalFilter}
            inputRef={searchRef}
            className="min-w-56 flex-1"
          />
          <span className="hidden items-center gap-1 text-xs text-muted md:flex">
            <Kbd>/</Kbd> to search
          </span>
          <div className="flex items-center gap-1">
            <Select
              aria-label="Sort by"
              options={sortOptions}
              value={sort.id}
              onChange={(id) => setSorting([{ id, desc: sort.desc }])}
              className="w-40"
            />
            <Tooltip content={sort.desc ? 'Descending' : 'Ascending'}>
              <Button
                variant="tertiary"
                isIconOnly
                aria-label={sort.desc ? 'Sort ascending' : 'Sort descending'}
                onPress={() => setSorting([{ id: sort.id, desc: !sort.desc }])}
              >
                {sort.desc ? (
                  <ArrowDownWideNarrow className="size-4" />
                ) : (
                  <ArrowUpNarrowWide className="size-4" />
                )}
              </Button>
            </Tooltip>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <MultiToggle
            aria-label="Severity"
            options={severities
              .filter((s) => counts[s] > 0)
              .map((s) => ({
                id: s,
                label: (
                  <span className="flex items-center gap-1.5">
                    <span className={`size-2 rounded-full ${severityBg[s]}`} />
                    {severityLabel[s]}
                    <span className="tabular text-muted">{counts[s]}</span>
                  </span>
                ),
              }))}
            value={filterValue(columnFilters, 'severity')}
            onChange={(value) => setColumnFilters((f) => setFilter(f, 'severity', value))}
          />
          {languages.length > 1 ? (
            <MultiToggle
              aria-label="Language"
              options={languages.map((l) => ({ id: l, label: l }))}
              value={filterValue(columnFilters, 'language')}
              onChange={(value) => setColumnFilters((f) => setFilter(f, 'language', value))}
            />
          ) : null}
          {tools.length > 1 ? (
            <MultiToggle
              aria-label="Package manager"
              options={tools.map((t) => ({ id: t, label: t }))}
              value={filterValue(columnFilters, 'tool')}
              onChange={(value) => setColumnFilters((f) => setFilter(f, 'tool', value))}
            />
          ) : null}
          {filtered ? (
            <Button
              variant="ghost"
              size="sm"
              onPress={() => {
                setColumnFilters([])
                setGlobalFilter('')
              }}
            >
              <FilterX className="size-4" />
              Clear
            </Button>
          ) : null}
          <span className="ml-auto text-xs text-muted" aria-live="polite">
            {rows.length === data.length
              ? plural(data.length, 'finding')
              : `${rows.length} of ${data.length} findings`}
          </span>
        </div>
      </div>

      {groups.length === 0 ? (
        <EmptyState
          icon={<SearchX />}
          title="No findings match"
          description="Try fewer filters or a different search."
        />
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <LanguageSection key={group.language} group={group} />
          ))}
        </div>
      )}
    </div>
  )
}

function LanguageSection({ group }: { group: LanguageGroup }) {
  return (
    <section aria-label={group.language} className="flex flex-col gap-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <span
          className="size-2.5 rounded-full"
          style={{ background: languageColor(group.language) }}
        />
        {group.language}
        <span className="font-normal text-muted">{plural(group.count, 'finding')}</span>
      </h3>
      {group.tools.map((tool) => (
        <div
          key={tool.label}
          className="overflow-hidden rounded-2xl border border-border bg-surface shadow-surface"
        >
          <div className="flex items-center justify-between gap-2 border-b border-separator bg-default-soft px-4 py-2.5">
            <span className="text-sm font-medium">{tool.label}</span>
            <span className="flex items-center gap-2 text-xs text-muted">
              {plural(tool.count, 'finding')} <SeverityChip severity={tool.worst} compact />
            </span>
          </div>
          {tool.sources.map((source) => (
            <div key={source.source} className="border-b border-separator last:border-b-0">
              <div className="flex items-center gap-2 px-4 pt-3 text-xs text-muted">
                <FileCode2 className="size-3.5" />
                <span className="font-mono">{source.source}</span>
              </div>
              <ul className="flex flex-col gap-2 p-3">
                <AnimatePresence initial={false}>
                  {source.packages.map((pkg) => (
                    <motion.li
                      key={pkg.key}
                      layout="position"
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.18 }}
                      className="rounded-xl border border-separator"
                    >
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                        <span className="font-mono text-[13px] font-medium">
                          {pkg.name}
                          <span className="text-muted">@{pkg.version}</span>
                        </span>
                        <span className="text-xs text-muted">{pkg.ecosystem}</span>
                        <span className="ml-auto text-xs text-muted">
                          {plural(pkg.rows.length, 'advisory', 'advisories')}
                        </span>
                      </div>
                      <ul className="divide-y divide-separator border-t border-separator">
                        {pkg.rows.map((row) => (
                          <FindingItem key={row.key} row={row} />
                        ))}
                      </ul>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            </div>
          ))}
        </div>
      ))}
    </section>
  )
}

function FindingItem({ row }: { row: FindingRow }) {
  const { finding } = row
  const fix = firstFix(finding)
  return (
    <li className="grid gap-x-3 gap-y-1.5 px-3 py-2.5 sm:grid-cols-[6.5rem_minmax(0,1fr)]">
      <div>
        <SeverityChip severity={finding.severity} />
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="font-mono text-[13px]">
            {finding.package.name}@{finding.package.version}
            <span className="mx-1.5 text-muted">→</span>
            {fix ? (
              <span className="font-medium text-success">{fix}</span>
            ) : (
              <span className="text-muted">no fix yet</span>
            )}
          </span>
          {finding.url ? (
            <a
              href={finding.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-mono text-xs text-accent hover:underline focus-visible:outline-2 focus-visible:outline-focus"
            >
              {finding.id}
              <ExternalLink className="size-3" />
            </a>
          ) : (
            <span className="font-mono text-xs">{finding.id}</span>
          )}
          {finding.aliases.map((alias) => (
            <span
              key={alias}
              className="rounded-md bg-default px-1.5 py-0.5 font-mono text-[11px] text-muted"
            >
              {alias}
            </span>
          ))}
        </div>
        {finding.summary ? <p className="text-sm text-muted">{finding.summary}</p> : null}
        {finding.fixedVersions.length > 1 ? (
          <p className="text-xs text-muted">
            Also fixed in {finding.fixedVersions.slice(1).join(', ')}
          </p>
        ) : null}
      </div>
    </li>
  )
}
