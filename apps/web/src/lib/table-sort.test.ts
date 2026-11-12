import { expect, test } from 'bun:test'

import { ariaSort, compareSortValues, nextSort, sortRows } from './table-sort.ts'

test('cycles a column through ascending, descending and none', () => {
  const asc = nextSort(null, 'name')
  expect(asc).toEqual({ key: 'name', direction: 'asc' })
  const desc = nextSort(asc, 'name')
  expect(desc).toEqual({ key: 'name', direction: 'desc' })
  expect(nextSort(desc, 'name')).toBeNull()
})

test('starts another column ascending', () => {
  expect(nextSort({ key: 'name', direction: 'desc' }, 'size')).toEqual({
    key: 'size',
    direction: 'asc',
  })
})

test('reports aria-sort for the sorted column only', () => {
  expect(ariaSort({ key: 'name', direction: 'asc' }, 'name')).toBe('ascending')
  expect(ariaSort({ key: 'name', direction: 'desc' }, 'name')).toBe('descending')
  expect(ariaSort({ key: 'name', direction: 'asc' }, 'size')).toBe('none')
  expect(ariaSort(null, 'name')).toBe('none')
})

test('compares strings naturally and without case', () => {
  expect(['widget-v10', 'Widget-v2', 'gadget'].toSorted(compareSortValues)).toEqual([
    'gadget',
    'Widget-v2',
    'widget-v10',
  ])
})

test('compares numbers, dates and booleans by value and puts empty values last', () => {
  expect([3, null, 1, Number.NaN, 2].toSorted(compareSortValues)).toEqual([
    1,
    2,
    3,
    null,
    Number.NaN,
  ])
  expect(compareSortValues(new Date('2026-01-02'), new Date('2026-01-01'))).toBeGreaterThan(0)
  expect(compareSortValues(false, true)).toBeLessThan(0)
  expect(compareSortValues(undefined, 'a')).toBe(1)
})

test('sorts rows stably with empty values last in both directions', () => {
  const rows = [
    { id: 'a', size: 2 },
    { id: 'b', size: null },
    { id: 'c', size: 1 },
    { id: 'd', size: 2 },
  ]
  const by = (row: (typeof rows)[number]) => row.size
  expect(sortRows(rows, { key: 'size', direction: 'asc' }, by).map((r) => r.id)).toEqual([
    'c',
    'a',
    'd',
    'b',
  ])
  expect(sortRows(rows, { key: 'size', direction: 'desc' }, by).map((r) => r.id)).toEqual([
    'a',
    'd',
    'c',
    'b',
  ])
  const unsorted = sortRows(rows, null, by)
  expect(unsorted).toEqual(rows)
  expect(unsorted).not.toBe(rows)
})

test('sortRows keeps NaN last when sorting descending', () => {
  expect(sortRows([1, Number.NaN, 3], { key: 'n', direction: 'desc' }, (n) => n)).toEqual([
    3,
    1,
    Number.NaN,
  ])
})
