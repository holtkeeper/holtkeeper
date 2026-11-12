import { expect, test } from 'bun:test'

import type { LicensedPackage, LicensesData } from './model.ts'
import { compareVerdict, licensesAnalysis, licensesMetrics, licensesReport } from './report.ts'

const pkg = (
  name: string,
  verdict: LicensedPackage['verdict'],
  licenses: string[],
  extra: Partial<LicensedPackage> = {},
): LicensedPackage => ({
  name,
  version: '1.0.0',
  ecosystem: 'npm',
  sources: ['package-lock.json'],
  licenses,
  verdict,
  ...(verdict === 'allowed' || verdict === 'ignored' || verdict === 'internal'
    ? {}
    : { culprits: licenses.length > 0 ? licenses : ['UNKNOWN'] }),
  ...extra,
})

const data = (packages: LicensedPackage[]): LicensesData => ({
  tool: { name: 'osv-scanner', version: '2.7.0' },
  policy: { allow: ['MIT'], deny: ['GPL-*'], ignore: [] },
  packages,
})

const previous = data([
  pkg('react', 'allowed', ['MIT']),
  pkg('old-gpl', 'denied', ['GPL-2.0-only']),
  pkg('mpl', 'unlisted', ['MPL-2.0']),
])
const current = data([
  pkg('react', 'allowed', ['MIT']),
  pkg('lodash', 'allowed', ['MIT']),
  pkg('mpl', 'unlisted', ['MPL-2.0'], { version: '2.0.0' }),
  pkg('readline', 'denied', ['GPL-3.0-only'], { groups: ['dev'] }),
  pkg('mystery', 'unknown', []),
])

test('metrics carry deltas against the previous analysis', () => {
  const report = licensesReport(current, { previous })
  expect(report.metrics.map(({ id, value, delta, tone }) => ({ id, value, delta, tone }))).toEqual([
    { id: 'packages', value: 5, delta: 2, tone: undefined },
    { id: 'violations', value: 2, delta: 0, tone: 'bad' },
    { id: 'unknown', value: 1, delta: 1, tone: 'warning' },
    { id: 'licenses', value: 3, delta: 0, tone: undefined },
  ])
})

test('violations mark new ones and list new and resolved since the previous analysis', () => {
  const report = licensesReport(current, { previous, compareTo: 'v1.0.0' })
  const section = report.sections.find((s) => s.id === 'violations')
  const [issues, since] = section?.blocks ?? []
  if (issues?.type !== 'issues' || since?.type !== 'table') throw new Error('unexpected blocks')
  expect(issues.items.map((item) => [item.title, item.tone, item.tags])).toEqual([
    ['readline@1.0.0: GPL-3.0-only (denied)', 'bad', ['npm', 'dev', 'new']],
    ['mpl@2.0.0: MPL-2.0 (not allowed)', 'warning', ['npm']],
  ])
  expect(issues.items[0]?.detail).toBe(
    'Offending: GPL-3.0-only\nFound in package-lock.json\nDependency kind: dev',
  )
  expect(since.title).toBe('Since v1.0.0')
  expect(since.rows.map((row) => [row.package, (row.status as { text: string }).text])).toEqual([
    ['readline', 'new'],
    ['old-gpl', 'resolved'],
  ])
})

test('license mix, unknown and packages sections', () => {
  const report = licensesReport(current)
  expect(report.sections.map((s) => s.id)).toEqual([
    'violations',
    'license-mix',
    'unknown',
    'packages',
  ])
  const [chart] = report.sections[1]?.blocks ?? []
  expect(chart).toMatchObject({ type: 'chart', chart: 'donut', x: 'license' })
  if (chart?.type !== 'chart') throw new Error('no chart')
  expect(chart.data).toEqual([
    { license: 'MIT', packages: 2 },
    { license: 'GPL-3.0-only', packages: 1 },
    { license: 'MPL-2.0', packages: 1 },
    { license: 'UNKNOWN', packages: 1 },
  ])
  const [unknown] = report.sections[2]?.blocks ?? []
  expect(unknown?.type === 'table' && unknown.rows.map((row) => row.package)).toEqual(['mystery'])
  const [packages] = report.sections[3]?.blocks ?? []
  expect(packages?.type === 'table' && packages.rows.length).toBe(5)
  expect(report.sections[0]?.blocks).toHaveLength(1)
})

test('internal packages get their own section and metric and read as internal', () => {
  const report = licensesReport(
    data([
      pkg('react', 'allowed', ['MIT']),
      pkg('@co/ui', 'internal', [], { definedIn: 'work:libs/ui' }),
    ]),
  )
  expect(report.metrics.find((m) => m.id === 'internal')?.value).toBe(1)
  expect(report.sections.map((s) => s.id)).toEqual([
    'violations',
    'license-mix',
    'unknown',
    'internal',
    'packages',
  ])
  const [table] = report.sections[3]?.blocks ?? []
  expect(table?.type === 'table' && table.rows).toEqual([
    { package: '@co/ui', version: '1.0.0', definedIn: 'work:libs/ui', source: 'package-lock.json' },
  ])
  const [chart] = report.sections[1]?.blocks ?? []
  expect(chart?.type === 'chart' && chart.data).toEqual([
    { license: 'internal', packages: 1 },
    { license: 'MIT', packages: 1 },
  ])
  expect(licensesAnalysis.schema.safeParse(data([pkg('@co/ui', 'internal', [])])).success).toBe(
    true,
  )
})

test('the analysis kind validates data and builds a report with its subject', () => {
  expect(licensesAnalysis.schema.parse(current)).toEqual(current)
  const repo = { forge: 'gitlab', path: 'team/app' }
  const report = licensesAnalysis.toReport(
    {
      id: '2',
      repo,
      kind: 'licenses',
      ref: 'v2',
      createdAt: '2026-10-30T00:00:00.000Z',
      data: current,
    },
    {
      id: '1',
      repo,
      kind: 'licenses',
      ref: 'v1',
      createdAt: '2026-10-01T00:00:00.000Z',
      data: previous,
    },
  )
  expect(report.subject).toEqual({ repo, ref: 'v2', compareTo: 'v1' })
  expect(licensesAnalysis.summarize(current).find((m) => m.id === 'violations')?.value).toBe(2)
})

const issueIds = (report: ReturnType<typeof licensesReport>) =>
  report.sections[0]?.blocks.flatMap((block) =>
    block.type === 'issues' ? block.items.map((item) => item.id) : [],
  )

test('warns about a missing repository license only when the policy requires one', () => {
  const required = (licenseFiles: string[]): LicensesData => ({
    ...data([pkg('react', 'allowed', ['MIT'])]),
    policy: { allow: ['MIT'], deny: [], ignore: [], requireProjectLicense: true },
    project: { licenseFiles },
  })

  const missing = licensesReport(required([]))
  expect(missing.metrics.find((m) => m.id === 'project-license')).toMatchObject({
    value: 0,
    tone: 'warning',
  })
  expect(issueIds(missing)).toEqual(['project-license-missing'])

  const present = licensesReport(required(['LICENSE']))
  expect(present.metrics.find((m) => m.id === 'project-license')?.tone).toBe('good')
  expect(issueIds(present)).toEqual([])

  const notRequired = licensesReport({ ...data([]), project: { licenseFiles: [] } })
  expect(notRequired.metrics.map((m) => m.id)).not.toContain('project-license')
  expect(issueIds(notRequired)).toEqual([])
})

test('metrics keep every license and the worst verdict of a package over its versions', () => {
  const scan = data([
    pkg('widget', 'allowed', ['MIT']),
    pkg('widget', 'denied', ['GPL-3.0-only'], { version: '2.0.0' }),
    pkg('widget', 'allowed', ['MIT'], { version: '3.0.0' }),
  ])
  expect(licensesMetrics(scan).byPackage).toEqual({
    'npm:widget': { licenses: ['GPL-3.0-only', 'MIT'], verdict: 'denied' },
  })
})

test('flagged details merge the flagged versions of a package under its worst verdict', () => {
  const scan = data([
    pkg('widget', 'unknown', [], { groups: ['dev'] }),
    pkg('widget', 'denied', ['GPL-3.0-only'], { version: '2.0.0', groups: ['dev'] }),
    pkg('widget', 'allowed', ['MIT'], { version: '3.0.0' }),
  ])
  expect(licensesMetrics(scan).flaggedDetails).toEqual({
    'npm:widget': {
      name: 'widget',
      ecosystem: 'npm',
      versions: ['1.0.0', '2.0.0'],
      licenses: ['GPL-3.0-only'],
      verdict: 'denied',
      culprits: ['GPL-3.0-only', 'UNKNOWN'],
      dev: true,
    },
  })
})

test('compareVerdict orders verdicts worst first', () => {
  expect(
    (
      ['ignored', 'allowed', 'excepted', 'unknown', 'denied', 'internal', 'unlisted'] as const
    ).toSorted(compareVerdict),
  ).toEqual(['denied', 'unlisted', 'unknown', 'excepted', 'allowed', 'internal', 'ignored'])
})

test('excepted packages get their own section and metric and are no violations', () => {
  const excepted = data([
    pkg('react', 'allowed', ['MIT']),
    pkg('fooUtil', 'excepted', ['BUSL-1.1'], { exception: 'Licensed by contract.' }),
  ])
  const report = licensesReport(excepted)
  expect(report.metrics.find((m) => m.id === 'excepted')?.value).toBe(1)
  expect(report.metrics.find((m) => m.id === 'violations')?.value).toBe(0)
  const section = report.sections.find((s) => s.id === 'excepted')
  const [table] = section?.blocks ?? []
  expect(table?.type === 'table' && table.rows).toEqual([
    { package: 'fooUtil', version: '1.0.0', license: 'BUSL-1.1', reason: 'Licensed by contract.' },
  ])
  const metrics = licensesMetrics(excepted)
  expect(metrics.verdicts.excepted).toBe(1)
  expect(metrics.flaggedDetails).toEqual({})
  expect(licensesAnalysis.schema.safeParse(excepted).success).toBe(true)
})

test('metrics count packages per verdict', () => {
  expect(
    licensesMetrics({
      ...current,
      policy: { ...current.policy, requireProjectLicense: true },
      project: { licenseFiles: [] },
    }),
  ).toEqual({
    packages: 5,
    verdicts: {
      allowed: 2,
      unknown: 1,
      unlisted: 1,
      denied: 1,
      ignored: 0,
      internal: 0,
      excepted: 0,
    },
    violations: 2,
    missingProjectLicense: true,
    licenseFile: 'missing',
    licenses: { MIT: 2, 'MPL-2.0': 1, 'GPL-3.0-only': 1, UNKNOWN: 1 },
    allowedLicenses: ['MIT'],
    flagged: { denied: ['npm:readline'], unlisted: ['npm:mpl'], unknown: ['npm:mystery'] },
    flaggedDetails: {
      'npm:mpl': {
        name: 'mpl',
        ecosystem: 'npm',
        versions: ['2.0.0'],
        licenses: ['MPL-2.0'],
        verdict: 'unlisted',
        culprits: ['MPL-2.0'],
        dev: false,
      },
      'npm:readline': {
        name: 'readline',
        ecosystem: 'npm',
        versions: ['1.0.0'],
        licenses: ['GPL-3.0-only'],
        verdict: 'denied',
        culprits: ['GPL-3.0-only'],
        dev: true,
      },
      'npm:mystery': {
        name: 'mystery',
        ecosystem: 'npm',
        versions: ['1.0.0'],
        licenses: [],
        verdict: 'unknown',
        culprits: ['UNKNOWN'],
        dev: false,
      },
    },
    byPackage: {
      'npm:react': { licenses: ['MIT'], verdict: 'allowed' },
      'npm:lodash': { licenses: ['MIT'], verdict: 'allowed' },
      'npm:mpl': { licenses: ['MPL-2.0'], verdict: 'unlisted' },
      'npm:readline': { licenses: ['GPL-3.0-only'], verdict: 'denied' },
      'npm:mystery': { licenses: [], verdict: 'unknown' },
    },
  })
  expect(licensesMetrics(previous)).toMatchObject({
    missingProjectLicense: false,
    licenseFile: 'not-required',
  })
})

test('metrics leave internal packages out of the license mix and say when a license file is present', () => {
  const metrics = licensesMetrics({
    ...data([
      pkg('react', 'allowed', ['MIT']),
      pkg('widget-kit', 'internal', [], { definedIn: 'work:acme/widget-kit' }),
      pkg('left-pad', 'ignored', ['WTFPL']),
    ]),
    policy: { allow: ['MIT'], deny: [], ignore: ['left-pad'], requireProjectLicense: true },
    project: { licenseFiles: ['LICENSE'] },
  })
  expect(metrics).toMatchObject({
    packages: 3,
    licenseFile: 'present',
    licenses: { MIT: 1, WTFPL: 1 },
    allowedLicenses: ['MIT'],
    flagged: { denied: [], unlisted: [], unknown: [] },
  })
})
