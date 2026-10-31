import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { bundleAnalysis } from './analysis.ts'
import { analyzeBuildTarget } from './build-target.ts'
import type { BundleData } from './data.ts'
import {
  type BundleRecordLike,
  type BundleTarget,
  bundleAnalysisSchema,
  bundleSeries,
  bundleTargets,
  findTargetPoint,
} from './targets.ts'

const data = (gzip: number): BundleData => ({
  assets: [
    { file: 'a.js', name: 'a.js', kind: 'js', raw: gzip * 3, gzip, brotli: gzip, mapped: 0 },
  ],
  entrypoints: [
    {
      name: 'desktop',
      initial: ['a.js'],
      lazy: [],
      initialSize: { raw: gzip * 3, gzip, brotli: gzip },
      lazySize: { raw: 0, gzip: 0, brotli: 0 },
      packages: [],
      modules: [],
    },
  ],
  packages: [],
  modules: [],
  unmapped: 0,
})

const pkg = (version: string, gzip: number, at: string): BundleTarget => ({
  name: '@acme/ui',
  source: 'package',
  version,
  at,
  status: 'ok',
  data: data(gzip),
  package: { unpacked: gzip * 10, files: 3, dependencies: [], peerDependencies: [] },
})

const records: BundleRecordLike[] = [
  { id: 'r1', createdAt: '2026-01-01T00:00:00Z', ref: 'v1', data: data(100) },
  {
    id: 'r2',
    createdAt: '2026-02-01T00:00:00Z',
    ref: 'v2',
    data: {
      targets: [
        { name: 'app', source: 'build', status: 'failed', error: 'exit 1' },
        pkg('1.0.0', 40, '2025-12-01T00:00:00Z'),
        pkg('1.1.0', 50, '2026-01-15T00:00:00Z'),
      ],
    },
  },
  {
    id: 'r3',
    createdAt: '2026-03-01T00:00:00Z',
    ref: 'v3',
    data: {
      targets: [
        { name: 'app', source: 'build', status: 'ok', data: data(130) },
        pkg('1.1.0', 55, '2026-01-15T00:00:00Z'),
      ],
    },
  },
]

test('records before targets read as one app build', () => {
  expect(bundleTargets(data(1))).toEqual([
    { name: 'app', source: 'build', status: 'ok', data: data(1) },
  ])
  expect(bundleAnalysisSchema.safeParse(data(1)).success).toBe(true)
  expect(bundleAnalysisSchema.safeParse(records[1]?.data).success).toBe(true)
})

test('series keep one point per build record and per package version, by time', () => {
  const series = bundleSeries(records)
  expect(series.map((entry) => entry.name)).toEqual(['@acme/ui', 'app'])
  const [ui, app] = series
  expect(ui?.points.map((point) => [point.version, point.total?.gzip])).toEqual([
    ['1.0.0', 40],
    ['1.1.0', 55],
  ])
  expect(app?.points.map((point) => [point.ref, point.status, point.total?.gzip])).toEqual([
    ['v1', 'ok', 100],
    ['v2', 'failed', undefined],
    ['v3', 'ok', 130],
  ])
  expect(app?.points[0]?.entrypoints?.[0]?.name).toBe('desktop')
})

test('a point compares with the closest earlier measured point', () => {
  const app = findTargetPoint(records, { name: 'app' })
  expect(app?.current.record.id).toBe('r3')
  expect(app?.previous?.record.id).toBe('r1')
  const ui = findTargetPoint(records, { name: '@acme/ui', version: '1.1.0' })
  expect(ui?.current.target.data?.assets[0]?.gzip).toBe(55)
  expect(ui?.previous?.target.version).toBe('1.0.0')
  expect(findTargetPoint(records, { name: 'nope' })).toBeUndefined()
})

const asRecord = (record: BundleRecordLike) => ({
  ...record,
  kind: 'bundle',
  repo: { forge: 'gitlab', path: 'games/app' },
})

test('reports list targets of several, and fully describe a single one', () => {
  const [first, second, third] = records as [BundleRecordLike, BundleRecordLike, BundleRecordLike]
  const many = bundleAnalysis.toReport(asRecord(second), asRecord(first))
  expect(many.sections.map((section) => section.id)).toEqual(['targets'])
  expect(many.metrics.find((metric) => metric.id === 'failed')?.value).toBe(1)
  const single = bundleAnalysis.toReport(
    asRecord({
      ...third,
      data: { targets: [{ name: 'app', source: 'build', status: 'ok', data: data(130) }] },
    }),
    asRecord(first),
  )
  expect(single.sections.map((section) => section.id)).toContain('entrypoints')
  expect(single.metrics.find((metric) => metric.id === 'js-gzip')).toMatchObject({
    value: 130,
    delta: 30,
  })
})

test('a failing build or missing output becomes a failed target', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'holtkeeper-target-'))
  try {
    const { runner } = createFakeRunner(() => ({ exitCode: 2, stdout: '', stderr: 'boom' }))
    const failed = await analyzeBuildTarget({
      name: 'app',
      dir,
      dist: 'dist',
      command: ['npm', 'run', 'build'],
      runner,
    })
    expect(failed).toMatchObject({ name: 'app', source: 'build', status: 'failed' })
    expect(failed.error).toContain('boom')

    const missing = await analyzeBuildTarget({ name: 'app', dir, dist: ['dist', 'build'] })
    expect(missing.error).toContain('no build output at dist, build')

    await mkdir(join(dir, 'build'), { recursive: true })
    await writeFile(join(dir, 'build/index.js'), 'console.log(1)\n')
    const found = await analyzeBuildTarget({ name: 'app', dir, dist: ['dist', 'build'] })
    expect(found.status).toBe('ok')
    expect(found.data?.assets.map((asset) => asset.file)).toEqual(['index.js'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
