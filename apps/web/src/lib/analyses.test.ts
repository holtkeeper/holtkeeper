import { expect, test } from 'bun:test'

import type { AnalysisSummary, Report } from '@holtkeeper/api'

import {
  analysisPages,
  parseAnalysisSearch,
  recordRepoTab,
  sectionAnchor,
  splitChanges,
  stackRecords,
  trendMetrics,
  versionPoints,
} from './analyses.ts'

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

test('picks trend metrics by preference', () => {
  const list = [
    summary('2026-10-03', 300),
    summary('2026-10-02', undefined),
    summary('2026-10-01', 100),
  ]
  expect(trendMetrics(list, [/gzip/i, /size/i]).map((m) => m.id)).toEqual(['js-gzip'])
  expect(trendMetrics(list, [/entries/i, /gzip/i]).map((m) => m.id)).toEqual(['entries', 'js-gzip'])
  expect(trendMetrics([summary('x', undefined)], [/gzip/i]).map((m) => m.id)).toEqual(['entries'])
  expect(trendMetrics([])).toEqual([])
})

test('section anchors are safe ids', () => {
  expect(sectionAnchor('Module Cycles/2')).toBe('section-module-cycles-2')
})

test('analysis pages live under the Supply and Quality workspaces', () => {
  expect(Object.fromEntries([...analysisPages, stackRecords].map((p) => [p.kind, p.to]))).toEqual({
    bundle: '/quality/bundles',
    depgraph: '/supply/libraries',
    coverage: '/quality/coverage',
    branches: '/quality/branches',
    'ci-jobs': '/quality/ci',
    licenses: '/supply/licenses',
    'api-surface': '/supply/public-api',
    assets: '/quality/assets',
    review: '/quality/reviews',
    stack: '/supply/stack',
  })
  expect(analysisPages.every((p) => p.to === `/${p.workspace}/${p.section}`)).toBe(true)
})

test('a record links to the hub area of its kind', () => {
  expect(recordRepoTab('coverage')).toEqual({ tab: 'quality', section: 'coverage' })
  expect(recordRepoTab('ci-jobs')).toEqual({ tab: 'quality', section: 'ci' })
  expect(recordRepoTab('assets')).toEqual({ tab: 'quality', section: 'assets' })
  expect(recordRepoTab('review')).toEqual({ tab: 'quality', section: 'reviews' })
  expect(recordRepoTab('licenses')).toEqual({ tab: 'supply', section: 'licenses' })
  expect(recordRepoTab('renovate')).toBeUndefined()
})

test('analysis search keeps compare, a known view and a metric', () => {
  expect(parseAnalysisSearch({ compare: 'a1', repo: 'x', view: 'log', metric: 'js-gzip' })).toEqual(
    { compare: 'a1', view: 'log', metric: 'js-gzip' },
  )
  expect(parseAnalysisSearch({ compare: '', view: 'report' })).toEqual({})
  expect(parseAnalysisSearch({ view: 'changes' })).toEqual({ view: 'changes' })
})

test('suggested changes split away from the rest of the report', () => {
  const change = {
    id: 'c1',
    title: 'Use the Widget cache',
    files: [],
  } as unknown as Extract<
    Report['sections'][number]['blocks'][number],
    { type: 'changes' }
  >['items'][number]
  const report: Report = {
    kind: 'bundle',
    title: 'Bundle report',
    generatedAt: '2026-11-10T00:00:00.000Z',
    metrics: [],
    sections: [
      {
        id: 'sum',
        title: 'Summary',
        blocks: [
          { type: 'markdown', text: 'All good' },
          { type: 'changes', items: [change, change], applicable: true },
        ],
      },
      {
        id: 'fix',
        title: 'Fixes',
        blocks: [{ type: 'changes', items: [change], applicable: false }],
      },
    ],
  }
  const split = splitChanges(report)
  expect(split.count).toBe(3)
  expect(split.report.sections.map((s) => [s.id, s.blocks.map((b) => b.type)])).toEqual([
    ['sum', ['markdown']],
  ])
  expect(split.changes.map((s) => [s.id, s.blocks.length])).toEqual([
    ['sum', 1],
    ['fix', 1],
  ])
  expect(splitChanges({ ...report, sections: [] }).count).toBe(0)
})

test('version points: oldest first, scaled bars, A and B marked, release tags', () => {
  const records = [5, 4, 3, 2, 1].map((day) => ({
    ...summary(`2026-10-0${day}`, day === 2 ? undefined : day * 100),
    ref: day === 3 ? 'refs/tags/v1.2.0' : 'main',
  }))
  const points = versionPoints(
    records,
    { id: 'js-gzip', unit: 'bytes' },
    {
      a: '2026-10-03',
      b: '2026-10-05',
    },
  )
  expect(points.map((p) => p.id)).toEqual([
    '2026-10-01',
    '2026-10-02',
    '2026-10-03',
    '2026-10-04',
    '2026-10-05',
  ])
  expect(points.map((p) => p.role)).toEqual([undefined, undefined, 'a', undefined, 'b'])
  expect(points[0]?.height).toBeCloseTo(0.15)
  expect(points[4]?.height).toBe(1)
  expect(points[1]).toMatchObject({ height: 0, text: '—' })
  expect(points[1]?.value).toBeUndefined()
  expect(points[2]?.tag).toBe('v1.2.0')
  expect(points[0]?.tag).toBeUndefined()
})

test('version points keep B and, when it fits, A inside the window', () => {
  const records = Array.from({ length: 40 }, (_, index) =>
    summary(`2026-10-${String(index + 1).padStart(2, '0')}T00`, 100),
  )
  const window = versionPoints(records, { id: 'js-gzip' }, { b: '2026-10-10T00' }, 8)
  expect(window).toHaveLength(8)
  expect(window.at(-1)?.id).toBe('2026-10-12T00')
  expect(window.every((p) => p.height === 0.6)).toBe(true)
  const both = versionPoints(
    records,
    { id: 'js-gzip' },
    { a: '2026-10-02T00', b: '2026-10-30T00' },
    8,
  )
  expect(both.at(-1)?.id).toBe('2026-10-32T00')
  expect(both.some((p) => p.role === 'a')).toBe(false)
  expect(both.find((p) => p.role === 'b')?.id).toBe('2026-10-30T00')
  const near = versionPoints(
    records,
    { id: 'js-gzip' },
    { a: '2026-10-02T00', b: '2026-10-06T00' },
    8,
  )
  expect(near[0]?.id).toBe('2026-10-01T00')
  expect(near.map((p) => p.role).filter(Boolean)).toEqual(['a', 'b'])
  expect(versionPoints([], { id: 'x' }, { b: 'y' })).toEqual([])
})
