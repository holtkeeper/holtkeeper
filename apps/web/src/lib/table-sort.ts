type SortDirection = 'asc' | 'desc'

/** The column a table is sorted by; `null` keeps the rows in their own order. */
export type SortState<K extends string = string> = { key: K; direction: SortDirection } | null

/** A value a column sorts by; `null`, `undefined` and `NaN` always go last. */
export type SortValue = string | number | boolean | Date | null | undefined

/**
 * The sort after a click on the header of `key`: a new column starts ascending, then the same
 * column turns descending, then the sort is cleared.
 */
export function nextSort<K extends string>(current: SortState<K>, key: K): SortState<K> {
  if (current?.key !== key) return { key, direction: 'asc' }
  return current.direction === 'asc' ? { key, direction: 'desc' } : null
}

/** The `aria-sort` value of the header of `key`. */
export function ariaSort(current: SortState, key: string): 'ascending' | 'descending' | 'none' {
  if (current?.key !== key) return 'none'
  return current.direction === 'asc' ? 'ascending' : 'descending'
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

const rank = (value: SortValue): number =>
  value instanceof Date ? value.getTime() : typeof value === 'boolean' ? Number(value) : NaN

const isEmpty = (value: SortValue): boolean =>
  value === null || value === undefined || (typeof value === 'number' && Number.isNaN(value))

/**
 * Ascending order of two values: numbers, dates and booleans by value, strings by natural order
 * ignoring case (`v2` before `v10`). Empty values come after everything else.
 */
export function compareSortValues(a: SortValue, b: SortValue): number {
  const emptyA = isEmpty(a)
  const emptyB = isEmpty(b)
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1
  if (typeof a === 'string' && typeof b === 'string') return collator.compare(a, b)
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const left = typeof a === 'number' ? a : rank(a)
  const right = typeof b === 'number' ? b : rank(b)
  if (!Number.isNaN(left) && !Number.isNaN(right)) return left - right
  return collator.compare(String(a), String(b))
}

/**
 * A sorted copy of `rows`; equal rows keep their order and empty values stay last in both
 * directions. Without a sort the copy keeps the original order.
 */
export function sortRows<T, K extends string>(
  rows: readonly T[],
  sort: SortState<K>,
  value: (row: T, key: K) => SortValue,
): T[] {
  if (!sort) return [...rows]
  const sign = sort.direction === 'asc' ? 1 : -1
  return rows
    .map((row, index) => ({ row, index, value: value(row, sort.key) }))
    .toSorted((a, b) => {
      const order =
        isEmpty(a.value) || isEmpty(b.value)
          ? compareSortValues(a.value, b.value)
          : sign * compareSortValues(a.value, b.value)
      return order || a.index - b.index
    })
    .map((entry) => entry.row)
}
