import { expect, test } from 'bun:test'

import type { BundlePoint, BundleSeries } from '@holtkeeper/api'

import { chartEntrypoints, chartRows, overallChange, pointLabel, targetRows } from './bundles.ts'

const sizes = (gzip: number) => ({ raw: gzip * 3, gzip, brotli: gzip - 1 })

const point = (id: string, gzip: number | undefined, entries: Record<string, number> = {}) =>
  ({
    analysisId: id,
    at: `2026-01-0${id}T00:00:00Z`,
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

test('target rows compare the newest two measured points and skip failures', () => {
  const lib: BundleSeries = { name: 'lib', source: 'package', points: [point('1', 500)] }
  const rows = targetRows([game, lib], 'gzip')
  expect(rows.map((row) => row.name)).toEqual(['lib', 'app'])
  expect(rows[1]).toMatchObject({ size: 130, delta: 30, points: 3, failed: false })
  expect(rows[0]?.delta).toBeUndefined()
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
