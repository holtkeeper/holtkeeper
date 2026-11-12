import { expect, test } from 'bun:test'

import { selectAll, selectAllState, selectOne } from './table-selection.ts'

test('reads the select-all state from the visible ids', () => {
  expect(selectAllState(new Set(), ['a', 'b'])).toBe('none')
  expect(selectAllState(new Set(['a', 'z']), ['a', 'b'])).toBe('some')
  expect(selectAllState(new Set(['a', 'b']), ['a', 'b'])).toBe('all')
  expect(selectAllState(new Set(['a']), [])).toBe('none')
})

test('selects and clears the visible ids only', () => {
  expect([...selectAll(new Set(['z']), ['a', 'b'], true)].toSorted()).toEqual(['a', 'b', 'z'])
  expect([...selectAll(new Set(['a', 'b', 'z']), ['a', 'b'], false)]).toEqual(['z'])
})

test('toggles one id without changing the input', () => {
  const selected = new Set(['a'])
  expect([...selectOne(selected, 'b', true)].toSorted()).toEqual(['a', 'b'])
  expect([...selectOne(selected, 'a', false)]).toEqual([])
  expect([...selected]).toEqual(['a'])
})
