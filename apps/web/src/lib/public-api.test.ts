import { expect, test } from 'bun:test'

import type { ApiSymbol } from '@holtkeeper/api'

import { documentedShare, groupSymbols, versionKey, versionLabel } from './public-api.ts'

const symbol = (name: string, kind: ApiSymbol['kind'], doc?: string): ApiSymbol => ({
  name,
  kind,
  signature: name,
  file: 'src/index.ts',
  line: 1,
  ...(doc ? { doc } : {}),
})

test('groupSymbols filters by name or doc and orders kinds', () => {
  const symbols = [
    symbol('Props', 'interface'),
    symbol('render', 'function', 'Draws a button'),
    symbol('Button', 'class'),
  ]
  expect(groupSymbols(symbols).map((group) => [group.label, group.symbols.length])).toEqual([
    ['Functions', 1],
    ['Classes', 1],
    ['Interfaces', 1],
  ])
  expect(groupSymbols(symbols, 'button').flatMap((g) => g.symbols.map((s) => s.name))).toEqual([
    'render',
    'Button',
  ])
})

test('versionLabel shows refs that differ from the version', () => {
  const base = { analysisId: 'a', analyzedAt: '2026-10-01T00:00:00Z', exports: 3 }
  expect(versionLabel({ ...base, version: '1.4.0', ref: 'v1.4.0', head: false })).toBe('1.4.0')
  expect(versionLabel({ ...base, version: '1.4.0', ref: '@acme/ui@1.4.0', head: false })).toBe(
    '1.4.0 · @acme/ui@1.4.0',
  )
  expect(
    versionLabel({
      ...base,
      version: '3.9.0',
      ref: '8628d6816e870c8a863b98066a30121df1862839',
      head: false,
    }),
  ).toBe('3.9.0 · 8628d681')
  expect(versionLabel({ ...base, version: '1.5.0', head: true })).toBe('head · 1.5.0')
  expect(versionKey({ ...base, version: '1.5.0', head: true })).toBe('head')
})

test('documentedShare', () => {
  expect(documentedShare(1, 3)).toBe(33)
  expect(documentedShare(0, 0)).toBeUndefined()
})
