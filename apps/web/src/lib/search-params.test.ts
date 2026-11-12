import { expect, test } from 'bun:test'

import { patchSearch, searchEntry, searchEnum, searchList, searchText } from './search-params.ts'

test('searchText keeps non-empty strings only', () => {
  expect(searchText('acme/widget-kit')).toBe('acme/widget-kit')
  expect(searchText('')).toBeUndefined()
  expect(searchText(3)).toBeUndefined()
})

test('searchEnum accepts only listed values', () => {
  expect(searchEnum('runs', ['findings', 'runs'] as const)).toBe('runs')
  expect(searchEnum('all', ['findings', 'runs'] as const)).toBeUndefined()
})

test('searchList reads arrays and comma lists, deduplicates and filters', () => {
  expect(searchList('a,b,,a')).toEqual(['a', 'b'])
  expect(searchList(['high', 'nope', 'low', 1], ['high', 'low'] as const)).toEqual(['high', 'low'])
  expect(searchList(undefined)).toEqual([])
})

test('searchEntry drops unset values and empty lists', () => {
  expect(searchEntry('q', 'zod')).toEqual({ q: 'zod' })
  expect(searchEntry('q', undefined)).toEqual({})
  expect(searchEntry('kind', [])).toEqual({})
})

test('patchSearch applies a patch and drops undefined keys', () => {
  const prev: { q?: string; tab?: string; open?: string } = { q: 'widget', open: 'x' }
  expect(patchSearch(prev, { open: undefined, tab: 'history' })).toEqual({
    q: 'widget',
    tab: 'history',
  })
})
