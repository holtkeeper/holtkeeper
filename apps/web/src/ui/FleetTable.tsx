import type { GroupMatch } from '@holtkeeper/api'
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react'

import { type ScopeView, foldOtherTeams } from '../lib/home-scope.ts'
import { fleetKeyCommand, stepKey } from '../lib/repos.ts'
import { isEditableTarget } from '../lib/slash-focus.ts'
import type { SortState } from '../lib/table-sort.ts'
import { type LegendItem, Legend } from './Legend.tsx'
import { ListFooter } from './ListFooter.tsx'
import { Kbd } from './Misc.tsx'
import { OtherTeams } from './OtherTeams.tsx'
import { ScopeSwitch } from './ScopeSwitch.tsx'
import { type StripCell, Strip } from './Strip.tsx'
import { Table, Td, Th } from './Table.tsx'

/**
 * One column of a `FleetTable`: a header, the cell of each row, and with `sortKey` a sortable
 * header.
 *
 * @public
 */
export interface FleetColumn<T, K extends string = string> {
  id: string
  header: ReactNode
  cell: (row: T) => ReactNode
  sortKey?: K
  align?: 'left' | 'right' | 'center'
  className?: string
}

const selectedRowClass = '[&>td]:bg-raise [&>td:first-child]:shadow-[inset_2px_0_var(--fg)]'

const fromControl = (target: EventTarget | null) =>
  target instanceof Element && target.closest('a, button, input, label') !== null

/**
 * The fleet list every workspace shares: a toolbar with the scope switch ("My teams | All I can
 * see"), the caller's filters and a legend; a summary `Strip` over the rows in scope; a sortable
 * table; and, in *My teams*, other teams' rows folded into one "Other teams · N" row that opens
 * them in place. `rows` arrive filtered and sorted; the table only splits them by home groups.
 * With `onOpen`, J and K select the next and previous row, Enter and a click open it.
 *
 * @public
 */
export function FleetTable<T extends { groups: readonly string[] }, K extends string = string>({
  label,
  rows,
  rowKey,
  columns,
  sort,
  onSort,
  scope,
  strip,
  stripExtra,
  legend,
  toolbar,
  onOpen,
  empty,
  noun = { one: 'repository', many: 'repositories' },
  othersSummary,
  caption,
}: {
  /** Accessible name of the table. */
  label: string
  rows: readonly T[]
  rowKey: (row: T) => string
  columns: readonly FleetColumn<T, K>[]
  sort?: SortState<K>
  onSort?: (next: SortState<K>) => void
  /** The scope switch; without it every row shows and nothing folds. */
  scope?: {
    value: ScopeView
    onChange: (view: ScopeView) => void
    homeGroups: readonly GroupMatch[]
  }
  /** Figures over the rows in scope, e.g. per health state. */
  strip?: (shown: readonly T[], view: ScopeView) => readonly StripCell[]
  /** Content under the strip and above the table, e.g. a breakdown bar. */
  stripExtra?: ReactNode
  legend?: readonly LegendItem[]
  /** Filter buttons and the like, after the scope switch. */
  toolbar?: ReactNode
  onOpen?: (row: T) => void
  /** Shown instead of the table when no row is in scope. */
  empty?: ReactNode
  /** What the rows are, for the folded row and the footer. */
  noun?: { one: string; many?: string }
  /** Quiet text after the count of the folded row, e.g. "38 healthy · 2 failing". */
  othersSummary?: (others: readonly T[]) => ReactNode
  /** Quiet text after "Showing N" in the footer. */
  caption?: ReactNode
}) {
  const view = scope?.value ?? 'all'
  const homeGroups = scope?.homeGroups ?? []
  const folded = foldOtherTeams(rows, homeGroups, (row) => row.groups)
  const shown = view === 'mine' ? folded.mine : rows
  const others = view === 'mine' ? folded.others : []
  const [othersOpen, setOthersOpen] = useState(false)
  const [selected, setSelected] = useState<string>()
  const body = useRef<HTMLTableSectionElement>(null)
  const navigable = [...shown, ...(othersOpen ? others : [])]
  const keys = navigable.map(rowKey)

  const onKey = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (!onOpen) return
    const command = fleetKeyCommand({
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      editable: isEditableTarget(event.target),
      inDialog: event.target instanceof Element && event.target.closest('[role="dialog"]') !== null,
    })
    if (!command || event.defaultPrevented) return
    if (command === 'open') {
      const row = navigable.find((candidate) => rowKey(candidate) === selected)
      if (!row || fromControl(event.target)) return
      event.preventDefault()
      onOpen(row)
      return
    }
    const next = stepKey(keys, selected, command)
    if (next === undefined) return
    event.preventDefault()
    setSelected(next)
    body.current
      ?.querySelector(`[data-row="${CSS.escape(next)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  })

  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => onKey(event)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  const renderRow = (row: T) => {
    const key = rowKey(row)
    const open = onOpen
      ? {
          tabIndex: -1,
          onClick: (event: MouseEvent<HTMLTableRowElement>) => {
            setSelected(key)
            if (!fromControl(event.target)) onOpen(row)
          },
          onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => {
            if (event.target === event.currentTarget && event.key === ' ') {
              event.preventDefault()
              onOpen(row)
            }
          },
        }
      : {}
    return (
      <tr
        key={key}
        data-row={key}
        {...(key === selected ? { 'aria-current': true } : {})}
        {...open}
        className={`hover:[&>td]:bg-raise ${key === selected ? selectedRowClass : ''} ${onOpen ? 'cursor-pointer' : ''}`}
      >
        {columns.map((column) => (
          <Td
            key={column.id}
            align={column.align ?? 'left'}
            valign="top"
            {...(column.className ? { className: column.className } : {})}
          >
            {column.cell(row)}
          </Td>
        ))}
      </tr>
    )
  }

  const cells = strip?.(shown, view)
  const total = view === 'mine' ? shown.length : rows.length

  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-panel">
      {scope || toolbar || legend?.length ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2.5">
          {scope ? (
            <ScopeSwitch
              value={scope.value}
              onChange={scope.onChange}
              counts={{ mine: folded.mine.length, all: rows.length }}
            />
          ) : null}
          {scope && toolbar ? <span aria-hidden className="mx-1 h-4 w-px bg-line" /> : null}
          {toolbar}
          {legend?.length ? (
            <Legend items={legend} label="Status legend" className="ms-auto" />
          ) : null}
        </div>
      ) : null}
      {cells?.length ? <Strip cells={cells} /> : null}
      {stripExtra ? <div className="border-b border-line">{stripExtra}</div> : null}
      {shown.length === 0 && others.length === 0 && empty ? (
        <div className="p-4">{empty}</div>
      ) : (
        <Table label={label}>
          <thead>
            <tr>
              {columns.map((column) => (
                <Th
                  key={column.id}
                  align={column.align ?? 'left'}
                  {...(column.className ? { className: column.className } : {})}
                  {...(column.sortKey !== undefined && onSort
                    ? { sortKey: column.sortKey, sort: sort ?? null, onSort }
                    : {})}
                >
                  {column.header}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody ref={body}>
            {shown.map(renderRow)}
            <OtherTeams
              variant="row"
              count={others.length}
              teams={folded.teams}
              colSpan={columns.length}
              noun={noun}
              open={othersOpen}
              onOpenChange={setOthersOpen}
              {...(othersSummary && others.length ? { summary: othersSummary(others) } : {})}
            >
              {others.map(renderRow)}
            </OtherTeams>
          </tbody>
        </Table>
      )}
      <ListFooter
        shown={shown.length + (othersOpen ? others.length : 0)}
        total={total + (othersOpen ? others.length : 0)}
        {...(noun.many ? { noun: noun.many } : {})}
        {...(caption ? { caption } : {})}
        {...(onOpen
          ? {
              hints: (
                <>
                  Navigate <Kbd>J</Kbd>
                  <Kbd>K</Kbd> · open <Kbd>↵</Kbd>
                </>
              ),
            }
          : {})}
        className="border-t border-line"
      />
    </div>
  )
}
