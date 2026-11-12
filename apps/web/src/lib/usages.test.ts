import { describe, expect, test } from 'bun:test'

import type { PackageUsageRepo } from '@holtkeeper/api'

import {
  consumerRows,
  importPath,
  kindCounts,
  memberLabel,
  relativeCounts,
  snippetLines,
  unusedExports,
} from './usages.ts'

describe('usage helpers', () => {
  test('labels members after the export', () => {
    expect(memberLabel('reset')).toBe('.reset')
    expect(memberLabel('().reset')).toBe('().reset')
  })

  test('numbers snippet lines and marks the used one', () => {
    expect(snippetLines({ snippet: 'a\nb\nc', snippetLine: 7, line: 8 })).toEqual([
      { number: 7, text: 'a', focus: false },
      { number: 8, text: 'b', focus: true },
      { number: 9, text: 'c', focus: false },
    ])
  })

  test('orders kinds and scales counts to the largest', () => {
    expect(kindCounts({ type: 1, jsx: 4 })).toEqual([
      { kind: 'jsx', count: 4 },
      { kind: 'type', count: 1 },
    ])
    expect(
      relativeCounts([
        { name: 'a', count: 4 },
        { name: 'b', count: 1 },
      ]),
    ).toEqual([
      { name: 'a', count: 4, share: 100 },
      { name: 'b', count: 1, share: 25 },
    ])
  })
})

test('importPath names the entry point', () => {
  expect(importPath('widget-kit', '.')).toBe('widget-kit')
  expect(importPath('widget-kit', './button')).toBe('widget-kit/button')
})

test('unusedExports skips re-exports and used names', () => {
  expect(
    unusedExports(
      [
        {
          symbols: [
            { name: 'Panel', kind: 'function' },
            { name: 'Tooltip', kind: 'function' },
            { name: 'other', kind: 'reexport' },
          ],
        },
        {
          symbols: [
            { name: 'Tooltip', kind: 'function' },
            { name: 'Drawer', kind: 'class' },
          ],
        },
      ],
      ['Panel'],
    ),
  ).toEqual(['Tooltip', 'Drawer'])
})

const user = (path: string, majorsBehind: number, versions: string[]) => ({
  repo: { forge: 'gitlab', path },
  groups: ['Web'],
  versions,
  majorsBehind,
})
const record = (path: string, fields: Partial<PackageUsageRepo> = {}): PackageUsageRepo => ({
  repo: { forge: 'gitlab', path },
  groups: ['Platform'],
  analysisId: 'a1',
  analyzedAt: '2026-11-01T00:00:00.000Z',
  versions: [],
  ranges: ['^4.0.0'],
  workspaces: ['root', 'apps/shop'],
  count: 12,
  files: 3,
  exports: [],
  ...fields,
})

describe('consumerRows', () => {
  test('joins usage records, most behind first', () => {
    const rows = consumerRows(
      [user('acme/checkout-web', 0, ['4.2.0']), user('acme/storefront', 1, ['3.9.1'])],
      [record('acme/storefront', { versions: ['3.9.1', '4.1.3'] }), record('acme/notify-svc')],
    )
    expect(rows.map((row) => [row.repo.path, row.versions, row.uses])).toEqual([
      ['acme/storefront', ['3.9.1', '4.1.3'], 12],
      ['acme/checkout-web', ['4.2.0'], undefined],
      ['acme/notify-svc', ['^4.0.0'], 12],
    ])
    expect(rows[0]?.workspaces).toEqual(['apps/shop'])
    expect(rows[2]?.groups).toEqual(['Platform'])
  })
})
