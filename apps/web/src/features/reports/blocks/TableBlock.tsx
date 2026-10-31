import type { Block, Cell, Column } from '@holtkeeper/api'
import {
  type SortFn,
  type SortingState,
  columnFilteringFeature,
  createColumnHelper,
  createFilteredRowModel,
  createSortedRowModel,
  globalFilteringFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ChevronsUpDown, EyeOff } from 'lucide-react'
import { use, useMemo, useState } from 'react'

import { plural } from '../../../lib/format.ts'
import { cellSortValue, cellText, compareSortValues } from '../../../lib/units.ts'
import { LoadMore, SearchInput, tableScrollClass } from '../../../ui/index.ts'
import { ReportContext } from '../context.ts'
import { ExcludeDialog } from '../ExcludeDialog.tsx'
import { CellView } from './CellView.tsx'

type Row = Record<string, Cell>

const features = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
})

type Features = typeof features

const helper = createColumnHelper<Features, Row>()
const pageSize = 100

const numericUnit = (column: Column) =>
  column.unit === 'bytes' ||
  column.unit === 'count' ||
  column.unit === 'percent' ||
  column.unit === 'ms' ||
  column.format === 'delta'

const stickyFirst = (index: number, base: string) =>
  index === 0 ? `sticky left-0 ${base} shadow-[1px_0_0_var(--separator)]` : ''

const isEnd = (column: Column, rows: readonly Row[]) =>
  column.align
    ? column.align === 'end'
    : numericUnit(column) && rows.some((row) => typeof row[column.key] === 'number')

/** A sortable, searchable table with unit-aware cells, optionally grouped by one column. */
export function TableBlock({ block }: { block: Extract<Block, { type: 'table' }> }) {
  const [sorting, setSorting] = useState<SortingState>([])
  const [globalFilter, setGlobalFilter] = useState('')
  const [limit, setLimit] = useState(pageSize)
  const [excluding, setExcluding] = useState<string | null>(null)
  const exclude = use(ReportContext)?.exclude
  const visibleColumns = useMemo(
    () => block.columns.filter((c) => c.key !== block.groupBy),
    [block],
  )

  const columns = useMemo(() => {
    const sortFn: SortFn<Features, Row> = (a, b, id) =>
      compareSortValues(cellSortValue(a.original[id]), cellSortValue(b.original[id]))
    return helper.columns(
      block.columns.map((column) =>
        helper.accessor((row) => cellText(row[column.key], column.unit), {
          id: column.key,
          header: column.label,
          sortFn,
          sortDescFirst: numericUnit(column),
        }),
      ),
    )
  }, [block])

  const table = useTable({
    features,
    columns,
    data: block.rows,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: (row, columnId, value: string) =>
      cellText(row.original[columnId]).toLowerCase().includes(value.trim().toLowerCase()),
  })

  const rows = table.getRowModel().rows
  const shown = rows.slice(0, limit)
  const groups: { key: string; rows: typeof shown }[] = []
  for (const row of shown) {
    const key = block.groupBy ? cellText(row.original[block.groupBy]) || '—' : ''
    const last = groups.at(-1)
    const existing = block.groupBy ? groups.find((g) => g.key === key) : last
    if (existing) existing.rows.push(row)
    else groups.push({ key, rows: [row] })
  }

  return (
    <div className="flex flex-col gap-3">
      {block.rows.length > 8 ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SearchInput
            aria-label={`Search ${block.title ?? 'table'}`}
            value={globalFilter}
            onChange={setGlobalFilter}
            className="w-64"
          />
          <span className="text-xs text-muted" aria-live="polite">
            {rows.length === block.rows.length
              ? plural(rows.length, 'row')
              : `${rows.length} of ${block.rows.length} rows`}
          </span>
        </div>
      ) : null}
      <div className={tableScrollClass}>
        <table
          aria-label={block.title ?? 'Table'}
          className="w-full border-separate border-spacing-0 text-sm"
        >
          <thead>
            <tr>
              {visibleColumns.map((column, index) => {
                const sorted = table.getColumn(column.key)?.getIsSorted()
                const end = isEnd(column, block.rows)
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={
                      sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'
                    }
                    title={column.hint}
                    className={`sticky top-0 whitespace-nowrap border-b border-border bg-surface px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted ${end ? 'text-right' : 'text-left'} ${index === 0 ? 'z-[3]' : 'z-[2]'} ${stickyFirst(index, '')}`}
                  >
                    <button
                      type="button"
                      className={`inline-flex items-center gap-1 rounded hover:text-foreground focus-visible:outline-2 focus-visible:outline-focus ${end ? 'flex-row-reverse' : ''}`}
                      onClick={() => table.getColumn(column.key)?.toggleSorting()}
                    >
                      {column.label}
                      {sorted === 'asc' ? (
                        <ArrowUp className="size-3" />
                      ) : sorted === 'desc' ? (
                        <ArrowDown className="size-3" />
                      ) : (
                        <ChevronsUpDown className="size-3 opacity-40" />
                      )}
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.key || 'rows'}>
              {block.groupBy ? (
                <tr>
                  <th
                    scope="rowgroup"
                    colSpan={visibleColumns.length}
                    className="border-b border-separator bg-default-soft px-3 py-1.5 text-left text-xs font-semibold"
                  >
                    {group.key}{' '}
                    <span className="font-normal text-muted">· {group.rows.length}</span>
                  </th>
                </tr>
              ) : null}
              {group.rows.map((row) => (
                <tr key={row.id} className="group/row transition-colors hover:bg-default-soft">
                  {visibleColumns.map((column, index) => (
                    <td
                      key={column.key}
                      className={`border-b border-separator px-3 py-2 align-middle ${isEnd(column, block.rows) ? 'text-right tabular' : ''} ${stickyFirst(index, 'z-[1] bg-surface group-hover/row:bg-[linear-gradient(var(--default-soft),var(--default-soft))]')}`}
                    >
                      {column.path && exclude && cellText(row.original[column.key]) ? (
                        <span className="flex items-start gap-1">
                          <CellView cell={row.original[column.key]} column={column} />
                          <button
                            type="button"
                            aria-label={`Exclude ${cellText(row.original[column.key])}`}
                            title="Exclude from later runs"
                            onClick={() => setExcluding(cellText(row.original[column.key]))}
                            className="shrink-0 rounded p-0.5 text-muted opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-focus group-hover/row:opacity-100"
                          >
                            <EyeOff className="size-3.5" />
                          </button>
                        </span>
                      ) : (
                        <CellView cell={row.original[column.key]} column={column} />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
        {rows.length > limit ? (
          <LoadMore
            size="sm"
            className="sticky left-0 flex justify-center py-3"
            onLoad={() => setLimit((l) => l + pageSize * 4)}
          >
            Show more ({rows.length - limit} hidden)
          </LoadMore>
        ) : null}
      </div>
      {excluding && exclude ? (
        <ExcludeDialog
          path={excluding}
          repo={exclude.repo}
          exclude={exclude}
          onClose={() => setExcluding(null)}
        />
      ) : null}
      {rows.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted">No rows match.</p>
      ) : null}
    </div>
  )
}
