import { expect, test } from 'bun:test'

import type { RepoAssetsView } from '@holtkeeper/api'

import { canOptimize, filterRows, kindColor, policyLines, policySource } from './assets.ts'

const policy: RepoAssetsView['policy'] = {
  formats: { raster: 'avif+webp', svg: 'optimize', allowed: ['png', 'webp'] },
  maxBytes: { warn: 500_000, error: 1_000_000, perKind: { audio: { error: 3_000_000 } } },
  maxDimension: 2560,
  minSaving: { pct: 5, bytes: 1024 },
  ignore: ['vendor/**'],
  budgets: { perKind: { font: 400_000 } },
  mode: 'suggest-mr',
}

test('the policy reads as labelled lines', () => {
  const lines = Object.fromEntries(policyLines(policy).map((line) => [line.label, line.value]))
  expect(lines.Rasters).toBe('AVIF and WEBP next to PNG, JPEG and GIF from 8 kB')
  expect(lines.Allowed).toBe('png, webp')
  expect(lines['File size']).toContain('audio: error')
  expect(lines.Budgets).toContain('font')
  expect(lines.Reviews).toBe('comment and offer a merge request')
  const keep = policyLines({
    ...policy,
    formats: { raster: 'keep', svg: 'keep' },
    budgets: {},
    ignore: [],
  })
  expect(keep.find((line) => line.label === 'Rasters')?.value).toBe('keep their formats')
  expect(keep.some((line) => line.label === 'Budgets' || line.label === 'Allowed')).toBe(false)
})

test('the source of the effective policy is named', () => {
  expect(policySource({ level: 'default' })).toContain('Default policy')
  expect(policySource({ level: 'all' })).toContain('every repository')
  expect(policySource({ level: 'group', entry: { id: 'b', scope: { groups: ['web'] } } })).toBe(
    'Inherited from group web',
  )
  expect(policySource({ level: 'group' })).toBe('Inherited from a group')
  expect(policySource({ level: 'repo' })).toBe('Set for this repository')
})

const row = (severity: 'error' | 'warning' | 'info', format = 'png') => ({
  path: `a.${format}`,
  kind: 'image' as const,
  format,
  bytes: 1,
  severity,
  problems: [],
})

test('rows filter by severity and images can be optimized', () => {
  expect(filterRows([row('error'), row('info'), row('warning')], 'issues')).toHaveLength(2)
  expect(filterRows([row('info')], 'all')).toHaveLength(1)
  expect(canOptimize(row('info', 'JPG'))).toBe(true)
  expect(canOptimize({ kind: 'font', format: 'ttf' })).toBe(false)
  expect(kindColor('image')).toBe('var(--series-1)')
  expect(kindColor('unknown')).toBe('var(--series-8)')
})
