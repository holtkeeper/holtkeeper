import { Checkbox as HeroCheckbox } from '@heroui/react'
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'

import { selectAll, selectAllState, selectOne } from '../lib/table-selection.ts'
import { type SortState, ariaSort, nextSort } from '../lib/table-sort.ts'

/** Height cap of every data table; rows scroll inside under a sticky header. */
export const tableScrollClass = 'max-h-[min(70vh,48rem)] overflow-auto overscroll-contain'

/**
 * Data table frame with a capped height and a sticky header; use `Th` and `Td` inside.
 * `footer` sits inside the scroll area after the rows, the place for a `LoadMore`.
 */
export function Table({
  children,
  label,
  footer,
}: {
  children: ReactNode
  label: string
  footer?: ReactNode
}) {
  return (
    <div className={tableScrollClass}>
      <table aria-label={label} className="w-full border-separate border-spacing-0 text-sm">
        {children}
      </table>
      {footer ? <div className="py-3">{footer}</div> : null}
    </div>
  )
}

const thClass =
  'sticky top-0 z-[2] whitespace-nowrap border-b border-border bg-[var(--table-bg,var(--surface))] px-3.5 py-2 text-xs font-medium text-muted'

const justify = { left: 'justify-start', right: 'justify-end', center: 'justify-center' } as const

/**
 * A column header. With `sortKey` and `onSort` it becomes a button that cycles the column through
 * ascending, descending and unsorted, and carries the matching `aria-sort`. With `sorted` alone it
 * marks the fixed order a list comes in.
 */
export function Th<K extends string = string>({
  children,
  align = 'left',
  className,
  sorted,
  sortKey,
  sort,
  onSort,
}: {
  children?: ReactNode
  align?: 'left' | 'right' | 'center'
  className?: string
  /** The fixed order of a column that cannot be re-sorted. */
  sorted?: 'ascending' | 'descending'
  /** The column's key in the table's `SortState`. */
  sortKey?: K
  /** The table's current sort. */
  sort?: SortState<K>
  /** Receives the sort after a click on this header. */
  onSort?: (next: SortState<K>) => void
}) {
  if (sortKey === undefined || !onSort) {
    const Fixed = sorted === 'ascending' ? ArrowUp : ArrowDown
    return (
      <th
        scope="col"
        {...(sorted && { 'aria-sort': sorted })}
        className={`${thClass} text-${align} ${sorted ? 'text-foreground' : ''} ${className ?? ''}`}
      >
        {sorted ? (
          <span className={`inline-flex items-center gap-1 ${justify[align]}`}>
            {children}
            <Fixed aria-hidden className="size-3 shrink-0" />
          </span>
        ) : (
          children
        )}
      </th>
    )
  }
  const state = ariaSort(sort ?? null, sortKey)
  const Icon = state === 'ascending' ? ArrowUp : state === 'descending' ? ArrowDown : ChevronsUpDown
  return (
    <th scope="col" aria-sort={state} className={`${thClass} text-${align} ${className ?? ''}`}>
      <button
        type="button"
        onClick={() => onSort(nextSort(sort ?? null, sortKey))}
        className={`-mx-1 inline-flex w-[calc(100%+0.5rem)] items-center gap-1 rounded px-1 hover:text-foreground focus-visible:outline-2 focus-visible:outline-focus ${justify[align]} ${state === 'none' ? '' : 'text-foreground'}`}
      >
        {children}
        <Icon aria-hidden className={`size-3 shrink-0 ${state === 'none' ? 'text-dim' : ''}`} />
      </button>
    </th>
  )
}

const valigns = { top: 'align-top', middle: 'align-middle' } as const

export function Td({
  children,
  align = 'left',
  valign = 'middle',
  className,
  onClick,
}: {
  children?: ReactNode
  align?: 'left' | 'right' | 'center'
  valign?: 'top' | 'middle'
  className?: string
  onClick?: (event: MouseEvent<HTMLTableCellElement>) => void
}) {
  return (
    <td
      className={`border-b border-separator px-3.5 py-2.5 ${valigns[valign]} text-${align} ${className ?? ''}`}
      {...(onClick && { onClick })}
    >
      {children}
    </td>
  )
}

const selectedRowClass = '[&>td]:bg-raise [&>td:first-child]:shadow-[inset_2px_0_var(--fg)]'

/**
 * A table row; `selected` marks it with the selected-row style and `aria-current`. With
 * `onClick` the row is focusable and Enter or Space runs it too.
 *
 * @public
 */
export function Tr({
  children,
  id,
  selected,
  className,
  onClick,
}: {
  children: ReactNode
  /** An anchor target, e.g. a setting a link scrolls to. */
  id?: string
  selected?: boolean
  className?: string
  onClick?: () => void
}) {
  return (
    <tr
      {...(id !== undefined && { id })}
      {...(selected ? { 'aria-current': true } : {})}
      {...(onClick
        ? {
            onClick,
            tabIndex: 0,
            onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => {
              if (event.target !== event.currentTarget) return
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              onClick()
            },
          }
        : {})}
      className={`hover:[&>td]:bg-raise ${selected ? selectedRowClass : ''} ${onClick ? 'cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus' : ''} ${className ?? ''}`}
    >
      {children}
    </tr>
  )
}

function RowCheckbox({
  label,
  isSelected,
  isIndeterminate,
  onChange,
}: {
  label: string
  isSelected: boolean
  isIndeterminate?: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <HeroCheckbox
      aria-label={label}
      isSelected={isSelected}
      isIndeterminate={isIndeterminate === true}
      onChange={onChange}
    >
      <HeroCheckbox.Control>
        <HeroCheckbox.Indicator />
      </HeroCheckbox.Control>
    </HeroCheckbox>
  )
}

/**
 * Header cell of the checkbox column: checks every id in `ids`, shows a dash while only some are
 * selected, and leaves selected ids outside `ids` untouched.
 *
 * @public
 */
export function SelectAllTh<K>({
  ids,
  selected,
  onChange,
  label = 'Select all rows',
}: {
  ids: readonly K[]
  selected: ReadonlySet<K>
  onChange: (next: Set<K>) => void
  label?: string
}) {
  const state = selectAllState(selected, ids)
  return (
    <th scope="col" className={`${thClass} w-9 pr-0`}>
      <RowCheckbox
        label={label}
        isSelected={state === 'all'}
        isIndeterminate={state === 'some'}
        onChange={(on) => onChange(selectAll(selected, ids, on))}
      />
    </th>
  )
}

/**
 * Body cell of the checkbox column for the row `id`; `label` names the row for screen readers.
 *
 * @public
 */
export function SelectTd<K>({
  id,
  selected,
  onChange,
  label,
}: {
  id: K
  selected: ReadonlySet<K>
  onChange: (next: Set<K>) => void
  label: string
}) {
  return (
    <td
      className="w-9 border-b border-separator py-2.5 pl-3.5 align-middle"
      onClick={(event) => event.stopPropagation()}
    >
      <RowCheckbox
        label={label}
        isSelected={selected.has(id)}
        onChange={(on) => onChange(selectOne(selected, id, on))}
      />
    </td>
  )
}
