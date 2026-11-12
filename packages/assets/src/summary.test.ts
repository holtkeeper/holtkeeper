import { expect, test } from 'bun:test'

import { assetsMetrics, parseAssetsMetrics } from './analysis.ts'
import type { AssetsData } from './data.ts'
import { assetsSummary } from './summary.ts'

const data: AssetsData = {
  roots: ['public/**'],
  engines: [],
  convert: 'estimate',
  tools: [],
  assets: [
    {
      path: 'public/a.png',
      kind: 'image',
      format: 'png',
      bytes: 900_000,
      hash: 'a',
      origin: 'source',
      image: { width: 3000, height: 2000 },
    },
    {
      path: 'public/b.png',
      kind: 'image',
      format: 'png',
      bytes: 20_000,
      hash: 'b',
      origin: 'source',
    },
    {
      path: 'public/c.png',
      kind: 'image',
      format: 'png',
      bytes: 20_000,
      hash: 'b',
      origin: 'source',
    },
    {
      path: 'public/d.wav',
      kind: 'audio',
      format: 'wav',
      bytes: 400_000,
      hash: 'd',
      origin: 'source',
    },
  ],
  totals: [
    { kind: 'image', count: 3, bytes: 940_000 },
    { kind: 'audio', count: 1, bytes: 400_000 },
  ],
  budgets: [],
  findings: [],
  suggestions: [
    {
      id: 's1',
      rule: 'opaque-png',
      path: 'public/a.png',
      kind: 'image',
      format: 'png',
      bytes: 900_000,
      suggested: 'webp',
      how: 'cwebp -q 82',
      expectedBytes: 300_000,
      method: 'estimate',
      saving: 600_000,
    },
    {
      id: 's2',
      rule: 'uncompressed-audio',
      path: 'public/d.wav',
      kind: 'audio',
      format: 'wav',
      bytes: 400_000,
      suggested: 'ogg',
      how: 'ffmpeg',
      expectedBytes: 100_000,
      method: 'estimate',
      saving: 300_000,
    },
  ],
  duplicates: [{ hash: 'b', bytes: 20_000, paths: ['public/b.png', 'public/c.png'] }],
  violations: [
    {
      id: 'max-bytes:public/a.png',
      rule: 'max-bytes',
      severity: 'warning',
      path: 'public/a.png',
      kind: 'image',
      format: 'png',
      actual: 900_000,
      limit: 500_000,
      message: '900 kB is above the warning limit of 500 kB',
    },
    {
      id: 'max-dimension:public/a.png',
      rule: 'max-dimension',
      severity: 'warning',
      path: 'public/a.png',
      actual: 3000,
      limit: 2560,
      message: '3000×2000 px is larger than 2560 px',
    },
    {
      id: 'budget:audio',
      rule: 'budget',
      severity: 'error',
      kind: 'audio',
      actual: 400_000,
      limit: 300_000,
      message: 'audio files together are 400 kB, above the budget of 300 kB',
    },
  ],
}

test('rows join violations, duplicates and savings per file, worst first', () => {
  const summary = assetsSummary(data)
  expect(summary).toMatchObject({
    files: 4,
    totalBytes: 1_340_000,
    errors: 1,
    warnings: 2,
    savings: 900_000,
    duplicateBytes: 20_000,
    more: 0,
  })
  expect(summary.budgets.map((budget) => budget.id)).toEqual(['budget:audio'])
  expect(summary.rows.map((row) => [row.path, row.severity])).toEqual([
    ['public/a.png', 'warning'],
    ['public/d.wav', 'info'],
    ['public/c.png', 'info'],
  ])
  expect(summary.rows[0]).toMatchObject({
    width: 3000,
    height: 2000,
    suggestion: { format: 'webp', saving: 600_000 },
  })
  expect(summary.rows[0]?.problems.map((problem) => problem.rule)).toEqual([
    'max-bytes',
    'max-dimension',
  ])
  expect(summary.rows[2]?.problems[0]?.message).toBe('same content as public/b.png')
})

test('the row limit counts what it leaves out', () => {
  const summary = assetsSummary(data, 1)
  expect(summary.rows).toHaveLength(1)
  expect(summary.more).toBe(2)
})

test('metrics: weight per kind, policy counts, file rows and the delta to the previous record', () => {
  const metrics = assetsMetrics(data)
  expect(metrics).toEqual({
    rows: assetsSummary(data).rows,
    moreRows: 0,
    files: 4,
    bytes: 1_340_000,
    kinds: { image: 940_000, audio: 400_000 },
    errors: 1,
    warnings: 2,
    budgets: 1,
    savings: 900_000,
    duplicateBytes: 20_000,
  })
  expect(assetsMetrics(data, { previous: { ...metrics, bytes: 1_000_000 } }).delta).toBe(340_000)
})

test('stored metrics read back, older ones without rows read as having none', () => {
  const metrics = assetsMetrics(data)
  expect(parseAssetsMetrics(JSON.parse(JSON.stringify(metrics)))).toEqual(metrics)
  const { rows: _rows, moreRows: _more, ...older } = metrics
  expect(parseAssetsMetrics(older)).toEqual({ ...older, rows: [], moreRows: 0 })
  expect(parseAssetsMetrics({ files: 'x' })).toBeUndefined()
  expect(parseAssetsMetrics(undefined)).toBeUndefined()
})
