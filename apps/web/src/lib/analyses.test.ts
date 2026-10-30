import { expect, test } from 'bun:test'

import type { AnalysisSummary } from '@holtkeeper/api'

import { latestPerRepo, metricSeries, sectionAnchor, trendMetrics, withDeltas } from './analyses.ts'

const summary = (createdAt: string, gzip: number | undefined): AnalysisSummary => ({
  id: createdAt,
  repo: { forge: 'w', path: 'web' },
  kind: 'bundle',
  label: createdAt,
  createdAt,
  metrics: [
    { id: 'version', label: 'Version', value: '1.0.0', unit: 'version' },
    { id: 'entries', label: 'Entrypoints', value: 3 },
    ...(gzip === undefined
      ? []
      : [{ id: 'js-gzip', label: 'JS gzip', value: gzip, unit: 'bytes' as const }]),
  ],
})

test('picks trend metrics by preference and builds a chronological series', () => {
  const list = [
    summary('2026-10-03', 300),
    summary('2026-10-02', undefined),
    summary('2026-10-01', 100),
  ]
  expect(trendMetrics(list, [/gzip/i, /size/i]).map((m) => m.id)).toEqual(['js-gzip'])
  expect(trendMetrics(list, [/entries/i, /gzip/i]).map((m) => m.id)).toEqual(['entries', 'js-gzip'])
  expect(metricSeries(list, 'js-gzip')).toEqual([
    { at: '2026-10-01', value: 100 },
    { at: '2026-10-03', value: 300 },
  ])
  expect(trendMetrics([summary('x', undefined)], [/gzip/i]).map((m) => m.id)).toEqual(['entries'])
  expect(trendMetrics([])).toEqual([])
})

test('section anchors are safe ids', () => {
  expect(sectionAnchor('Module Cycles/2')).toBe('section-module-cycles-2')
})

test('one card per repository: newest record, deltas against the one before, a series', () => {
  const other = { ...summary('2026-10-03', 900), id: 'o', repo: { forge: 'w', path: 'api' } }
  const cards = latestPerRepo(
    [summary('2026-10-03', 120), other, summary('2026-10-02', 100), summary('2026-10-01', 90)],
    'js-gzip',
  )
  expect(cards.map((c) => [c.latest.repo.path, c.count])).toEqual([
    ['web', 3],
    ['api', 1],
  ])
  expect(cards[0]?.metrics.find((m) => m.id === 'js-gzip')?.delta).toBe(20)
  expect(cards[0]?.series).toEqual([90, 100, 120])
  expect(cards[1]?.metrics.find((m) => m.id === 'js-gzip')?.delta).toBeUndefined()
})

test('withDeltas keeps reported deltas and skips text metrics', () => {
  const metrics = withDeltas(
    [
      { id: 'a', label: 'A', value: 5, delta: 1 },
      { id: 'b', label: 'B', value: 'n/a', unit: 'text' },
    ],
    [
      { id: 'a', label: 'A', value: 2 },
      { id: 'b', label: 'B', value: 3 },
    ],
  )
  expect(metrics.map((m) => m.delta)).toEqual([1, undefined])
})
