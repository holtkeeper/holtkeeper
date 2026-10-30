import { expect, test } from 'bun:test'

import type { LicensedPackage, LicensesData } from './model.ts'
import { licensesAnalysis, licensesReport } from './report.ts'

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
  ...(verdict === 'allowed' || verdict === 'ignored'
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
