import { expect, test } from 'bun:test'

import type { CoverageRepoCard } from '@holtkeeper/api'

import {
  belowTarget,
  coverageExcludes,
  coverageFreshness,
  coverageFreshnessLabel,
  coverageKpis,
  coverageRows,
  coverageSort,
  coverageSortValue,
  coverageTargetOf,
  coverageTone,
  filterCoverageRows,
  formatPercent,
  formatPoints,
  lineSegments,
  orgCoverageTarget,
  parseCoverageSearch,
  percentOf,
  pointsTone,
  resolvedCoverageTarget,
  testsEntryValue,
  testsToggle,
  trendValues,
  withCoverageSort,
} from './coverage.ts'
import { groupTitleOf } from './group-titles.ts'

const now = new Date('2026-11-12T12:00:00.000Z')

const card = (
  path: string,
  covered: number,
  total: number,
  extra: Partial<CoverageRepoCard> = {},
): CoverageRepoCard => ({
  repo: { forge: 'acme', path },
  groups: ['Web'],
  analysisId: `id-${path}`,
  createdAt: '2026-11-11T00:00:00.000Z',
  tools: ['vitest'],
  totals: { lines: { covered, total }, files: 10, untested: 2, untestedLines: 5 },
  trend: [],
  ...extra,
})

test('percent and tone follow the report thresholds', () => {
  expect(percentOf({ covered: 1, total: 4 })).toBe(25)
  expect(percentOf({ covered: 0, total: 0 })).toBeUndefined()
  expect([90, 80, 79.9, 50, 49, undefined].map(coverageTone)).toEqual([
    'success',
    'success',
    'warning',
    'warning',
    'danger',
    'default',
  ])
  expect(formatPercent(87.46)).toBe('87.5%')
  expect(formatPercent(undefined)).toBe('—')
})

test('points read as signed changes', () => {
  expect(formatPoints(2.46)).toBe('+2.5 pt')
  expect(formatPoints(-1)).toBe('−1 pt')
  expect(formatPoints(0.01)).toBe('')
  expect(formatPoints(undefined)).toBe('')
  expect([3, -3, 0].map(pointsTone)).toEqual(['success', 'danger', 'default'])
})

test('line segments split uncovered lines by whether a test loaded the file', () => {
  expect(
    lineSegments({
      lines: { covered: 60, total: 100 },
      files: 3,
      untested: 1,
      untestedLines: 25,
    }).map((segment) => [segment.tone, segment.value]),
  ).toEqual([
    ['success', 60],
    ['warning', 15],
    ['danger', 25],
  ])
})

const entry = (scope: object, value: unknown) => ({
  id: 'e',
  key: 'analyzers.coverage',
  scope,
  value,
  secret: false,
  updatedAt: '2026-11-01T00:00:00.000Z',
})

test('targets come from the option, the org entry or the default', () => {
  expect([70, '75', ' ', -1, 101, null, 'x'].map(coverageTargetOf)).toEqual([
    70, 75, 60, 60, 60, 60, 60,
  ])
  const definitions = [
    {
      key: 'analyzers.coverage',
      label: 'Coverage',
      description: '',
      section: 'analyzers',
      secret: false,
      schema: {},
      default: { target: 65 },
    },
  ]
  expect(orgCoverageTarget(undefined)).toBe(60)
  expect(orgCoverageTarget({ settings: [], definitions })).toBe(65)
  expect(
    orgCoverageTarget({
      settings: [
        entry({ repos: ['acme:acme/a'] }, { target: 90 }),
        entry({ all: true }, { target: 72 }),
      ],
      definitions,
    }),
  ).toBe(72)
  expect(
    orgCoverageTarget({ settings: [entry({ all: true }, { exclude: [] })], definitions }),
  ).toBe(65)
  expect(resolvedCoverageTarget({ target: 80 }, 60)).toBe(80)
  expect(resolvedCoverageTarget({}, 55)).toBe(55)
})

test('excludes read lists and comma strings, trimmed and unique', () => {
  expect(coverageExcludes({ exclude: ['src/gen/**', ' a ', 'a'] })).toEqual(['src/gen/**', 'a'])
  expect(coverageExcludes({ exclude: 'x/**, y/**,' })).toEqual(['x/**', 'y/**'])
  expect(coverageExcludes(undefined)).toEqual([])
})

test('rows: lowest coverage first, empty records next, unmeasured repositories last', () => {
  const rows = coverageRows(
    [card('acme/a', 9, 10), card('acme/b', 0, 0), card('acme/c', 1, 10)],
    [
      { repo: { forge: 'acme', path: 'acme/a' }, groups: ['Web'] },
      { repo: { forge: 'acme', path: 'acme/z' }, groups: ['Platform'] },
    ],
  )
  expect(rows.map((row) => [row.repo.path, Boolean(row.card)])).toEqual([
    ['acme/c', true],
    ['acme/a', true],
    ['acme/b', true],
    ['acme/z', false],
  ])
  expect(rows[3]?.groups).toEqual(['Platform'])
})

test('freshness of rows and their labels', () => {
  const [behind, never] = coverageRows(
    [card('acme/a', 1, 2, { sha: 'a1', head: 'b2' })],
    [{ repo: { forge: 'acme', path: 'acme/n' }, groups: [] }],
  )
  expect(behind && coverageFreshness(behind, now)).toBe('behind')
  expect(never && coverageFreshness(never, now)).toBe('never')
  expect(coverageFreshnessLabel.never).toBe('Not measured')
})

test('KPIs: medians over measured rows, below target, untested and freshness counts', () => {
  const rows = coverageRows(
    [
      card('acme/a', 4, 10, {
        totals: {
          lines: { covered: 4, total: 10 },
          branches: { covered: 1, total: 2 },
          files: 3,
          untested: 1,
          untestedLines: 0,
        },
      }),
      card('acme/b', 7, 10, { createdAt: '2026-10-01T00:00:00.000Z' }),
      card('acme/c', 9, 10),
    ],
    [{ repo: { forge: 'acme', path: 'acme/n' }, groups: [] }],
  )
  const kpis = coverageKpis(rows, 60, now)
  expect(kpis).toMatchObject({
    repos: 4,
    measured: 3,
    medianLines: 70,
    medianBranches: 50,
    below: 1,
    untested: 5,
    freshness: { current: 2, behind: 0, aging: 0, stale: 1, never: 1 },
  })
  expect(rows.map((row) => belowTarget(row, 75))).toEqual([true, true, false, false])
})

test('filters by text, freshness and below target', () => {
  const rows = coverageRows(
    [card('acme/checkout-web', 4, 10), card('acme/ledger-api', 9, 10, { groups: ['Payments'] })],
    [{ repo: { forge: 'acme', path: 'acme/notify-svc' }, groups: ['Platform'] }],
  )
  const paths = (search: Parameters<typeof filterCoverageRows>[1]) =>
    filterCoverageRows(rows, search, 60, undefined, now).map((row) => row.repo.path)
  expect(paths({ q: 'LEDGER' })).toEqual(['acme/ledger-api'])
  expect(paths({ q: 'platform' })).toEqual(['acme/notify-svc'])
  expect(paths({ freshness: ['never'] })).toEqual(['acme/notify-svc'])
  expect(paths({ below: true })).toEqual(['acme/checkout-web'])
  const titleOf = groupTitleOf({ Payments: 'Money Desk' })
  expect(
    filterCoverageRows(rows, { q: 'money' }, 60, titleOf, now).map((row) => row.repo.path),
  ).toEqual(['acme/ledger-api'])
})

test('sort values keep unmeasured rows empty', () => {
  const [row, none] = coverageRows(
    [card('acme/a', 1, 4, { change: -2 })],
    [{ repo: { forge: 'acme', path: 'acme/n' }, groups: [] }],
  )
  if (!row || !none) throw new Error('rows missing')
  expect(coverageSortValue(row, 'lines', now)).toBe(25)
  expect(coverageSortValue(row, 'change', now)).toBe(-2)
  expect(coverageSortValue(row, 'untested', now)).toBe(2)
  expect(coverageSortValue(row, 'freshness', now)).toBe(4)
  expect(coverageSortValue(none, 'lines', now)).toBeUndefined()
  expect(coverageSortValue(none, 'freshness', now)).toBeUndefined()
  expect(coverageSortValue(none, 'repo', now)).toBe('acme:acme/n')
})

test('trend values keep gaps', () => {
  expect(
    trendValues({
      trend: [{ at: '2026-10-20T03:00:00.000Z', lines: 40 }, { at: '2026-10-27T03:00:00.000Z' }],
    }),
  ).toEqual([40, null])
})

test('coverage search keeps known values only', () => {
  expect(
    parseCoverageSearch({
      repo: 'acme:acme/widgets',
      tab: 'x',
      q: 'web',
      group: 'Web,Payments',
      freshness: ['never', 'odd'],
      below: 'true',
      sort: 'lines',
      dir: 'desc',
    }),
  ).toEqual({
    repo: 'acme:acme/widgets',
    q: 'web',
    freshness: ['never'],
    below: true,
    sort: 'lines',
    dir: 'desc',
  })
  expect(parseCoverageSearch({ repo: '', below: 'no', sort: 'odd' })).toEqual({})
  const search = parseCoverageSearch({ sort: 'change' })
  expect(coverageSort(search)).toEqual({ key: 'change', direction: 'asc' })
  expect(withCoverageSort(search, null)).toEqual({})
  expect(withCoverageSort({}, { key: 'repo', direction: 'desc' })).toEqual({
    sort: 'repo',
    dir: 'desc',
  })
})

test('repositories with no tests by design sort last and stay out of the figures', () => {
  const noTests = { reason: 'Config only' }
  const rows = coverageRows(
    [card('shapes/widget', 1, 10), card('shapes/gadget', 6, 10), card('shapes/widget-core', 9, 10)],
    [
      { repo: { forge: 'acme', path: 'shapes/widget' }, groups: ['Web'], noTests },
      { repo: { forge: 'acme', path: 'shapes/docs' }, groups: ['Web'], noTests: {} },
      { repo: { forge: 'acme', path: 'shapes/new' }, groups: ['Web'] },
    ],
  )
  expect(rows.map((row) => [row.repo.path, row.noTests])).toEqual([
    ['shapes/gadget', undefined],
    ['shapes/widget-core', undefined],
    ['shapes/new', undefined],
    ['shapes/docs', {}],
    ['shapes/widget', noTests],
  ])
  const widget = rows[4]
  if (!widget) throw new Error('row missing')
  expect(coverageFreshness(widget, now)).toBe('no-tests')
  expect(coverageFreshnessLabel['no-tests']).toBe('No tests by design')
  expect(belowTarget(widget, 60)).toBe(false)
  expect(coverageSortValue(widget, 'lines', now)).toBeUndefined()
  expect(coverageSortValue(widget, 'freshness', now)).toBeUndefined()
  expect(coverageKpis(rows, 60, now)).toEqual({
    repos: 3,
    measured: 2,
    medianLines: 75,
    below: 0,
    untested: 4,
    noTests: 2,
    freshness: { current: 2, behind: 0, aging: 0, stale: 0, never: 1 },
  })
  expect(
    filterCoverageRows(rows, { freshness: ['no-tests'] }, 60, undefined, now).map(
      (row) => row.repo.path,
    ),
  ).toEqual(['shapes/docs', 'shapes/widget'])
  expect(parseCoverageSearch({ freshness: 'no-tests' }).freshness).toEqual(['no-tests'])
})

test('the tests toggle marks, removes the own entry or overrides a broader one', () => {
  expect(testsToggle(undefined)).toBeUndefined()
  expect(testsToggle({ expected: false, scope: { groups: ['shapes'] } })).toBeUndefined()
  expect(testsToggle({ expected: true, configurable: true })).toEqual({ kind: 'mark' })
  expect(
    testsToggle({ expected: true, entryId: 'e0', inherited: false, configurable: true }),
  ).toEqual({ kind: 'mark', entryId: 'e0' })
  expect(
    testsToggle({
      expected: false,
      scope: { repos: ['acme:shapes/widget'] },
      entryId: 'e1',
      inherited: true,
      configurable: true,
    }),
  ).toEqual({ kind: 'remove', entryId: 'e1' })
  expect(
    testsToggle({
      expected: false,
      scope: { repos: ['acme:shapes/widget'] },
      entryId: 'e1',
      inherited: false,
      configurable: true,
    }),
  ).toEqual({ kind: 'override', entryId: 'e1', overrides: { repos: ['acme:shapes/widget'] } })
  expect(
    testsToggle({ expected: false, scope: { groups: ['shapes'] }, configurable: true }),
  ).toEqual({ kind: 'override', overrides: { groups: ['shapes'] } })
  expect(testsToggle({ expected: false, configurable: true })).toEqual({ kind: 'override' })
  expect(testsEntryValue(false, ' Config only ')).toEqual({
    expected: false,
    reason: 'Config only',
  })
  expect(testsEntryValue(false, '  ')).toEqual({ expected: false })
  expect(testsEntryValue(true, 'ignored')).toEqual({ expected: true })
})
