import { expect, test } from 'bun:test'

import type { AnalysisSummary } from '@holtkeeper/api'

import { metricSeries, sectionAnchor, trendMetrics } from './analyses.ts'

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
