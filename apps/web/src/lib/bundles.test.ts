import { expect, test } from 'bun:test'

import type { BundlePoint, BundleSeries, BundlesOverview, BundleTargetRow } from '@holtkeeper/api'

import {
  budgetShare,
  budgetState,
  bundleKpis,
  bundleRows,
  bundleSortValue,
  bundlesSort,
  chartEntrypoints,
  chartRows,
  deltaPercent,
  filterBundleRows,
  historyRows,
  overallChange,
  parseBundlesSearch,
  pointLabel,
  rowRelease,
  sheetSections,
  worstFirst,
} from './bundles.ts'
import { sortRows } from './table-sort.ts'

const sizes = (gzip: number) => ({ raw: gzip * 3, gzip, brotli: gzip - 1 })

const point = (id: string, gzip: number | undefined, entries: Record<string, number> = {}) =>
  ({
    analysisId: id,
    at: `2026-01-0${id}T00:00:00Z`,
    measuredAt: `2026-01-0${id}T00:00:00Z`,
    status: gzip === undefined ? 'failed' : 'ok',
    ...(gzip === undefined
      ? { error: 'build failed' }
      : {
          total: sizes(gzip),
          entrypoints: Object.entries(entries).map(([name, size]) => ({
            name,
            initial: sizes(size),
            lazy: sizes(0),
          })),
        }),
  }) satisfies BundlePoint

const game: BundleSeries = {
  name: 'app',
  source: 'build',
  points: [
    point('1', 100, { desktop: 60, mobile: 40 }),
    point('2', undefined),
    point('3', 130, { desktop: 70, mobile: 50, replay: 20 }),
  ],
}

test('labels points by version, short commit, ref or date', () => {
  expect(pointLabel({ ...point('1', 1), version: '1.2.0' })).toBe('1.2.0')
  expect(pointLabel({ ...point('1', 1), ref: 'a'.repeat(40) })).toBe('aaaaaaaa')
  expect(pointLabel({ ...point('1', 1), ref: 'v2.0.0' })).toBe('v2.0.0')
  expect(pointLabel(point('1', 1))).toBe('2026-01-01')
})

test('history rows are newest first with the change against the measured point before', () => {
  const rows = historyRows(game, 'gzip')
  expect(rows.map((row) => [row.index, row.size, row.delta])).toEqual([
    [2, 130, 30],
    [1, undefined, undefined],
    [0, 100, undefined],
  ])
})

test('chart rows leave gaps for failed points and follow the largest entrypoints', () => {
  const entries = chartEntrypoints(game, 'gzip')
  expect(entries).toEqual(['desktop', 'mobile', 'replay'])
  const rows = chartRows(game, 'gzip', entries)
  expect(rows.map((row) => row.total)).toEqual([100, null, 130])
  expect(rows[0]?.['entry:replay']).toBeNull()
  expect(rows[2]?.['entry:desktop']).toBe(70)
  expect(overallChange(game, 'gzip')).toEqual({ first: 100, last: 130, delta: 30, measured: 2 })
})

const target = (name: string, patch: Partial<BundleTargetRow> = {}): BundleTargetRow => ({
  name,
  source: 'build',
  status: 'ok',
  gzip: 100,
  overBudget: false,
  series: [],
  analysisId: `rec-${name}`,
  createdAt: '2026-01-05T00:00:00Z',
  ...patch,
})

const overview: BundlesOverview = {
  repos: [
    {
      repo: { forge: 'acme', path: 'acme/storefront' },
      groups: ['Web'],
      analysisId: 'rec-1',
      createdAt: '2026-01-05T00:00:00Z',
      ref: 'v4.12.0',
      failed: 1,
      overBudget: 1,
      records: 3,
      targets: [
        target('web', { gzip: 412, budget: 400, verdict: 'over', overBudget: true, delta: 12 }),
        target('admin', { status: 'failed', gzip: undefined }),
      ],
    },
    {
      repo: { forge: 'acme', path: 'acme/widget-kit' },
      groups: ['Platform'],
      analysisId: 'rec-2',
      createdAt: '2026-01-04T00:00:00Z',
      ref: 'a'.repeat(40),
      failed: 0,
      overBudget: 0,
      records: 2,
      targets: [
        target('widget-kit', {
          source: 'package',
          version: '2.1.0',
          gzip: 95,
          budget: 100,
          verdict: 'near',
          delta: -5,
        }),
        target('docs', { gzip: 50 }),
      ],
    },
  ],
}

test('overview rows carry their repository, groups and ref', () => {
  const rows = bundleRows(overview)
  expect(rows.map((row) => row.key)).toEqual([
    'acme:acme/storefront#web',
    'acme:acme/storefront#admin',
    'acme:acme/widget-kit#widget-kit',
    'acme:acme/widget-kit#docs',
  ])
  expect(rows[0]).toMatchObject({ repoKey: 'acme:acme/storefront', groups: ['Web'] })
  expect(rows.map(rowRelease)).toEqual(['v4.12.0', 'v4.12.0', '2.1.0', 'aaaaaaaa'])
})

test('budget state, share and percent change of a target', () => {
  const [web, admin, kit, docs] = bundleRows(overview)
  expect([web, admin, kit, docs].map((row) => row && budgetState(row))).toEqual([
    'over',
    'failed',
    'near',
    'none',
  ])
  expect(web && budgetShare(web)).toBe(1.03)
  expect(docs && budgetShare(docs)).toBeUndefined()
  expect(kit && deltaPercent(kit)).toBe(-5)
  expect(admin && deltaPercent(admin)).toBeUndefined()
})

test('rows go worst first and sort by any column with empty values last', () => {
  const rows = bundleRows(overview)
  expect(worstFirst(rows).map((row) => row.name)).toEqual(['web', 'admin', 'widget-kit', 'docs'])
  const bySize = sortRows(rows, { key: 'size', direction: 'desc' }, bundleSortValue)
  expect(bySize.map((row) => row.name)).toEqual(['web', 'widget-kit', 'docs', 'admin'])
  expect(bundlesSort({ sort: 'budget', dir: 'desc' })).toEqual({ key: 'budget', direction: 'desc' })
  expect(bundlesSort({})).toBeNull()
})

test('filters narrow by repository, text, kind and budget state', () => {
  const rows = bundleRows(overview)
  const names = (search: Parameters<typeof filterBundleRows>[1]) =>
    filterBundleRows(rows, search).map((row) => row.name)
  expect(names({ repo: 'acme:acme/widget-kit' })).toEqual(['widget-kit', 'docs'])
  expect(names({ q: 'STORE' })).toEqual(['web', 'admin'])
  expect(names({ kind: ['package'] })).toEqual(['widget-kit'])
  expect(names({ budget: ['over', 'failed'] })).toEqual(['web', 'admin'])
})

test('strip figures count kinds, budget states, growth and failures', () => {
  expect(bundleKpis(bundleRows(overview))).toEqual({
    targets: 4,
    builds: 3,
    packages: 1,
    over: 1,
    near: 1,
    grew: 1,
    grewBy: 12,
    failed: 1,
  })
})

test('sheet tabs split the report sections', () => {
  const sections = ['overview', 'entrypoints', 'composition', 'packages', 'assets', 'package'].map(
    (id) => ({ id, title: id, blocks: [] }),
  )
  const ids = (tab: Parameters<typeof sheetSections>[1]) =>
    sheetSections(sections, tab).map((section) => section.id)
  expect(ids('composition')).toEqual(['overview', 'composition', 'assets'])
  expect(ids('entrypoints')).toEqual(['entrypoints'])
  expect(ids('packages')).toEqual(['packages', 'package'])
  expect(ids('history')).toEqual([])
})

test('bundles search keeps known values and drops the rest', () => {
  expect(
    parseBundlesSearch({
      repo: 'acme:acme/widgets',
      q: 'web',
      kind: 'build,app',
      budget: ['over', 'x'],
      sort: 'size',
      dir: 'desc',
      open: 'acme:acme/widgets',
      target: 'web',
      tab: 'history',
      version: '',
      analysis: 'a1',
      x: 'y',
    }),
  ).toEqual({
    repo: 'acme:acme/widgets',
    q: 'web',
    kind: ['build'],
    budget: ['over'],
    sort: 'size',
    dir: 'desc',
    open: 'acme:acme/widgets',
    target: 'web',
    tab: 'history',
    analysis: 'a1',
  })
  expect(parseBundlesSearch({ sort: 'nope', dir: 'desc', tab: 'nope' })).toEqual({})
})
