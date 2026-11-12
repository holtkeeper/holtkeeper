import { expect, test } from 'bun:test'

import type {
  AssetsOverview,
  AssetsRepoSummary,
  RepoAssetsView,
  SettingList,
} from '@holtkeeper/api'

import {
  assetRowKey,
  assetTableRows,
  assetsKpis,
  canOptimize,
  fleetPolicy,
  kindColor,
  kindLabel,
  overridesText,
  parseAssetsSearch,
  policyLines,
  policySource,
  problemLabel,
  rowMeta,
  savingPercent,
  searchAssetRows,
  severityTone,
  singleChoice,
  toAssetsQuery,
  trendText,
  withPolicyDefaults,
} from './assets.ts'

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
  expect(lines['In reviews']).toBe('comment and offer a merge request')
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

test('the group of a group-scoped source is named, nested matches flattened', () => {
  expect(
    policySource({ level: 'group', entry: { id: 'c', scope: { groups: [['web', 'apps']] } } }),
  ).toBe('Inherited from group web, apps')
})

const repo = { forge: 'acme', path: 'acme/widgets' }
const other = { forge: 'acme', path: 'acme/gadgets' }

const asset = (path: string, extra: Partial<AssetsOverview['items'][number]> = {}) => ({
  path,
  kind: 'image' as const,
  format: 'png',
  bytes: 1000,
  severity: 'error' as const,
  problems: [],
  repo,
  analysisId: 'a1',
  ...extra,
})

const summary = (extra: Partial<AssetsRepoSummary> = {}): AssetsRepoSummary => ({
  repo,
  groups: ['web'],
  analysisId: 'a1',
  createdAt: '2026-11-01T00:00:00.000Z',
  files: 10,
  bytes: 1000,
  kinds: { image: 800, font: 200 },
  errors: 2,
  warnings: 1,
  budgets: 0,
  savings: 300,
  duplicateBytes: 50,
  moreRows: 0,
  ...extra,
})

test('rows carry their repository groups and repeated rows are dropped', () => {
  const pages: AssetsOverview[] = [
    { repos: [summary()], items: [asset('a.png'), asset('b.png')], total: 3, nextCursor: '2' },
    { repos: [summary()], items: [asset('b.png'), asset('c.png', { repo: other })], total: 3 },
  ]
  const rows = assetTableRows(pages)
  expect(rows.map((row) => row.key)).toEqual([
    'acme:acme/widgets|a.png',
    'acme:acme/widgets|b.png',
    'acme:acme/gadgets|c.png',
  ])
  expect(rows[0]?.groups).toEqual(['web'])
  expect(rows[2]?.groups).toEqual([])
  expect(assetRowKey(asset('x.png'))).toBe('acme:acme/widgets|x.png')
})

test('rows match every word against repository, path and format', () => {
  const rows = [asset('img/hero.png'), asset('fonts/a.woff2', { format: 'woff2', repo: other })]
  expect(searchAssetRows(rows, 'gadgets woff')).toHaveLength(1)
  expect(searchAssetRows(rows, 'HERO')).toHaveLength(1)
  expect(searchAssetRows(rows, '  ')).toHaveLength(2)
  expect(searchAssetRows(rows, undefined)).toHaveLength(2)
  expect(searchAssetRows(rows, 'nothing')).toHaveLength(0)
})

test('kpis sum repositories, kinds keep display order, trend weighs by bytes', () => {
  const kpi = assetsKpis([
    summary({ delta: 100, budgets: 1 }),
    summary({ repo: other, bytes: 3000, kinds: { video: 3000 }, delta: -100 }),
    summary({ repo: other, bytes: 500, kinds: {} }),
  ])
  expect(kpi.repos).toBe(3)
  expect(kpi.bytes).toBe(4500)
  expect(kpi.savings).toBe(900)
  expect(kpi.errors).toBe(6)
  expect(kpi.budgets).toBe(1)
  expect(kpi.overBudget).toEqual([repo])
  expect(kpi.kinds.map((k) => k.kind)).toEqual(['image', 'video', 'font'])
  expect(kpi.trend).toBe(0)
  expect(assetsKpis([summary({ bytes: 1100, delta: 100 })]).trend).toBe(10)
  expect(assetsKpis([summary()]).trend).toBeUndefined()
  expect(assetsKpis([]).kinds).toEqual([])
})

test('trends, problems and rows read as short text', () => {
  expect(trendText(6.4)).toBe('↑ 6%')
  expect(trendText(-2.2)).toBe('↓ 2%')
  expect(trendText(0.3)).toBe('no change')
  expect(problemLabel({ rule: 'max-bytes', severity: 'error' })).toBe('Error · over the size limit')
  expect(problemLabel({ rule: 'modern-format', severity: 'warning' })).toBe(
    'Warning · no modern format',
  )
  expect(problemLabel({ rule: 'duplicate', severity: 'info' })).toBe('Duplicate')
  expect(rowMeta({ kind: 'image', width: 2400, height: 1600 })).toBe('image · 2400×1600')
  expect(rowMeta({ kind: 'font' })).toBe('font')
  expect(
    savingPercent({
      bytes: 1000,
      suggestion: { format: 'avif', how: '', expectedBytes: 170, saving: 830, method: 'measured' },
    }),
  ).toBe(83)
  expect(savingPercent({ bytes: 1000 })).toBe(0)
  expect(severityTone('error')).toBe('danger')
  expect(severityTone('info')).toBe('default')
  expect(kindLabel('image')).toBe('Images')
  expect(kindLabel('video')).toBe('Video')
})

test('images can be optimized and kinds keep their colors', () => {
  expect(canOptimize({ kind: 'image', format: 'JPG' })).toBe(true)
  expect(canOptimize({ kind: 'font', format: 'ttf' })).toBe(false)
  expect(canOptimize({ kind: 'image', format: 'tiff' })).toBe(false)
  expect(kindColor('image')).toBe('var(--series-1)')
  expect(kindColor('unknown')).toBe('var(--series-8)')
})

test('stored policies are filled from the defaults field by field', () => {
  const merged = withPolicyDefaults({ maxBytes: { warn: 250_000 }, mode: 'suggest-mr' }, policy)
  expect(merged.maxBytes).toEqual({ ...policy.maxBytes, warn: 250_000 })
  expect(merged.mode).toBe('suggest-mr')
  expect(merged.formats).toEqual(policy.formats)
  expect(withPolicyDefaults('broken', policy)).toBe(policy)
})

const settingList = (settings: SettingList['settings']): SettingList => ({
  definitions: [
    {
      key: 'assets.policy',
      label: 'Asset policy',
      description: '',
      section: 'Repositories',
      secret: false,
      schema: {},
      default: policy,
    },
  ],
  settings,
  people: {},
})

const entry = (id: string, scope: SettingList['settings'][number]['scope'], value: unknown) => ({
  id,
  key: 'assets.policy',
  scope,
  value,
  secret: false,
  updatedAt: '2026-11-01T00:00:00.000Z',
})

test('the fleet policy is the entry for every repository, else the default', () => {
  expect(fleetPolicy(settingList([]))).toEqual({
    policy,
    source: 'Default policy: nothing set for every repository',
    overrides: 0,
  })
  const fleet = fleetPolicy(
    settingList([
      entry('a', { all: true }, { maxDimension: 4096 }),
      entry('b', { groups: ['web'] }, {}),
      entry('c', { repos: ['acme/widgets'] }, {}),
    ]),
  )
  expect(fleet?.policy.maxDimension).toBe(4096)
  expect(fleet?.source).toBe('Set for every repository')
  expect(fleet?.overrides).toBe(2)
  expect(fleetPolicy({ definitions: [], settings: [], people: {} })).toBeUndefined()
  expect(overridesText(0)).toBe('')
  expect(overridesText(1)).toBe('1 group or repository overrides it')
  expect(overridesText(3)).toBe('3 groups or repositories override it')
})

test('a single-choice filter keeps the newly picked id', () => {
  expect(singleChoice(['png', 'webp'], 'png')).toBe('webp')
  expect(singleChoice([], 'png')).toBeUndefined()
  expect(singleChoice(['png'], undefined)).toBe('png')
  expect(singleChoice(['png'], 'png')).toBe('png')
})

test('assets search drops unknown and default values', () => {
  expect(
    parseAssetsSearch({
      repo: 'acme:acme/widgets',
      status: 'saving',
      kind: 'font',
      format: 'PNG',
      problem: 'duplicate',
      sort: 'size',
      q: 'hero',
      group: 'web',
      tab: 'x',
    }),
  ).toEqual({
    repo: 'acme:acme/widgets',
    status: 'saving',
    kind: 'font',
    format: 'png',
    problem: 'duplicate',
    sort: 'size',
    q: 'hero',
    group: 'web',
  })
  expect(
    parseAssetsSearch({ status: 'policy', sort: 'severity', kind: 'texture', problem: 'x' }),
  ).toEqual({})
  expect(parseAssetsSearch({})).toEqual({})
})

test('the query spells out defaults and leaves the text filter in the browser', () => {
  expect(toAssetsQuery({})).toEqual({ status: 'policy', sort: 'severity' })
  expect(
    toAssetsQuery({
      status: 'any',
      sort: 'saving',
      repo: 'acme:acme/widgets',
      kind: 'image',
      q: 'hero',
    }),
  ).toEqual({
    status: 'any',
    sort: 'saving',
    repo: 'acme:acme/widgets',
    kind: 'image',
  })
})
