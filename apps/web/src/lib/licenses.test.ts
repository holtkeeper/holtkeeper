import { describe, expect, test } from 'bun:test'

import type {
  LicensesOverview,
  LicensesRepoRow,
  LicenseViolation,
  SettingView,
} from '@holtkeeper/api'

import {
  deltaText,
  exceptedCount,
  filterLicenseRepos,
  filterViolations,
  licenseKpis,
  parseVerdict,
  mixParts,
  parseLicensesSearch,
  policyFacts,
  sortViolations,
  violationKey,
  violationLicense,
  violationRows,
  exceptionTargets,
  withLicenseException,
} from './licenses.ts'

test('parseLicensesSearch keeps known values', () => {
  expect(
    parseLicensesSearch({
      repo: 'gitlab:acme/ledger-api',
      verdict: 'denied,unlisted,allowed,bogus',
      ecosystem: 'Go',
      group: 'Payments,Web',
      sort: 'repos',
      q: 'gpl',
      package: 'npm:some-lib',
      tab: 'policy',
    }),
  ).toEqual({
    repo: 'gitlab:acme/ledger-api',
    verdict: ['denied', 'unlisted'],
    ecosystem: ['Go'],
    group: ['Payments', 'Web'],
    sort: 'repos',
    q: 'gpl',
    package: 'npm:some-lib',
    tab: 'policy',
  })
})

test('parseLicensesSearch drops defaults and junk', () => {
  expect(parseLicensesSearch({ sort: 'verdict', verdict: '', repo: 7 })).toEqual({})
  expect(parseLicensesSearch({ sort: 'since' })).toEqual({})
})

const violation = (overrides: Partial<LicenseViolation> = {}): LicenseViolation => ({
  package: 'tiny-yaml',
  ecosystem: 'npm',
  versions: ['3.0.2'],
  licenses: ['MPL-2.0'],
  verdict: 'unlisted',
  culprits: ['MPL-2.0'],
  dev: false,
  repos: [{ repo: 'gitlab:acme/checkout-web', groups: ['Web'] }],
  ...overrides,
})

const names = (list: LicenseViolation[]) => list.map((v) => v.package)

const violations = [
  violation({
    package: 'copyleft-kit',
    licenses: ['GPL-3.0-only'],
    verdict: 'denied',
    culprits: ['GPL-*'],
  }),
  violation(),
  violation({
    package: 'mystery',
    ecosystem: 'Go',
    licenses: [],
    verdict: 'unknown',
    culprits: [],
    repos: [
      { repo: 'gitlab:acme/ledger-api', groups: ['Payments'] },
      { repo: 'gitlab:acme/checkout-web', groups: ['Web'] },
    ],
  }),
]

const order = (sort: Parameters<typeof sortViolations>[1]) =>
  sortViolations(violations, sort).map((v) => v.package)

const repoRow = (repo: string, overrides: Partial<LicensesRepoRow> = {}): LicensesRepoRow => ({
  repo,
  groups: ['Web'],
  analysisId: `a-${repo}`,
  createdAt: '2026-11-10T00:00:00Z',
  packages: 100,
  verdicts: {
    allowed: 90,
    unknown: 1,
    unlisted: 2,
    denied: 0,
    ignored: 3,
    internal: 4,
    excepted: 0,
  },
  licenseFile: 'present',
  ...overrides,
})

describe('violations', () => {
  test('filters by verdict, ecosystem, group, repository and text', () => {
    expect(names(filterViolations(violations, { verdict: ['denied', 'unknown'] }))).toEqual([
      'copyleft-kit',
      'mystery',
    ])
    expect(names(filterViolations(violations, { ecosystem: ['Go'] }))).toEqual(['mystery'])
    expect(names(filterViolations(violations, { group: ['Payments'] }))).toEqual(['mystery'])
    expect(names(filterViolations(violations, { repo: 'gitlab:acme/ledger-api' }))).toEqual([
      'mystery',
    ])
    expect(names(filterViolations(violations, { q: 'gpl' }))).toEqual(['copyleft-kit'])
  })

  test('sorts by verdict, license, package and repositories', () => {
    expect(order('verdict')).toEqual(['copyleft-kit', 'tiny-yaml', 'mystery'])
    expect(order('license')).toEqual(['copyleft-kit', 'tiny-yaml', 'mystery'])
    expect(order('package')).toEqual(['copyleft-kit', 'mystery', 'tiny-yaml'])
    expect(order('repos')).toEqual(['mystery', 'copyleft-kit', 'tiny-yaml'])
  })

  test('rows carry keys and groups; licenses fall back to UNKNOWN', () => {
    const rows = violationRows(violations)
    expect(rows[2]?.key).toBe('Go:mystery')
    expect(rows[2]?.groups).toEqual(['Payments', 'Web'])
    expect(violationKey(violations[1]!)).toBe('npm:tiny-yaml')
    expect(violationLicense(violations[2]!)).toBe('UNKNOWN')
  })
})

test('filterLicenseRepos filters and puts the worst first', () => {
  const rows = [
    repoRow('gitlab:acme/a'),
    repoRow('gitlab:acme/b', {
      groups: ['Payments'],
      verdicts: {
        allowed: 1,
        unknown: 0,
        unlisted: 0,
        denied: 2,
        ignored: 0,
        internal: 0,
        excepted: 0,
      },
    }),
    repoRow('gitlab:acme/c', {
      verdicts: {
        allowed: 1,
        unknown: 0,
        unlisted: 0,
        denied: 0,
        ignored: 0,
        internal: 0,
        excepted: 0,
      },
    }),
  ]
  expect(filterLicenseRepos(rows, {}).map((r) => r.repo)).toEqual([
    'gitlab:acme/b',
    'gitlab:acme/a',
    'gitlab:acme/c',
  ])
  expect(filterLicenseRepos(rows, { group: ['Web'], q: 'acme/c' }).map((r) => r.repo)).toEqual([
    'gitlab:acme/c',
  ])
})

test('mixParts keeps the largest licenses and folds the rest', () => {
  const mix = [
    { license: 'MIT', packages: 60 },
    { license: 'Apache-2.0', packages: 20 },
    { license: 'ISC', packages: 10 },
    { license: 'BSD-3-Clause', packages: 6 },
    { license: '0BSD', packages: 4 },
  ]
  expect(mixParts(mix, 2)).toEqual([
    { license: 'MIT', packages: 60, percent: 60 },
    { license: 'Apache-2.0', packages: 20, percent: 20 },
    { license: '3 others', packages: 20, percent: 20 },
  ])
  expect(mixParts(mix.slice(0, 1))).toEqual([{ license: 'MIT', packages: 60, percent: 100 }])
  expect(mixParts([])).toEqual([])
})

test('deltaText', () => {
  expect(deltaText({ added: 2, resolved: 1 })).toBe('+2 · 1 resolved')
  expect(deltaText({ added: 3, resolved: 0 })).toBe('+3')
  expect(deltaText({ added: 0, resolved: 0 })).toBe('')
  expect(deltaText(undefined)).toBe('')
})

test('licenseKpis for the fleet and for one repository', () => {
  const overview: LicensesOverview = {
    kpi: {
      packages: 2318,
      repos: 10,
      denied: 6,
      review: 14,
      unknown: 5,
      licenses: 37,
      allowedLicenses: 31,
      internal: 118,
      missingLicenseFile: 3,
    },
    mix: [],
    violations,
    repos: [repoRow('gitlab:acme/checkout-web', { licenseFile: 'missing' })],
  }
  expect(licenseKpis(overview).licenses).toBe(37)
  expect(licenseKpis(overview, ['gitlab:acme/checkout-web'])).toEqual({
    packages: 100,
    repos: 1,
    denied: 0,
    review: 2,
    unknown: 1,
    licenses: 3,
    allowedLicenses: 0,
    missingLicenseFile: 1,
    internal: 4,
    excepted: 0,
  })
  expect(licenseKpis(overview, ['gitlab:acme/none']).repos).toBe(0)
  expect(licenseKpis(overview, []).packages).toBe(0)
})

test('parseVerdict reads verdict names only', () => {
  expect(parseVerdict('unlisted')).toBe('unlisted')
  expect(parseVerdict('toString')).toBeUndefined()
})

test('policyFacts', () => {
  expect(
    policyFacts({
      preset: 'Commercial product',
      allow: ['MIT'],
      deny: ['GPL-*'],
      ignore: [],
      unknown: 'warn',
      requireProjectLicense: true,
      overrides: 1,
      review: [],
      devDependencies: 'check',
      exceptions: [],
    }),
  ).toEqual([
    { label: 'Preset', value: 'Commercial product' },
    { label: 'Applies to', value: 'All repositories, 1 narrower entry overrides it' },
    { label: 'Unknown license', value: 'Review' },
    { label: 'Repository license', value: 'Required' },
    { label: 'Dev-only dependencies', value: 'Checked too' },
    { label: 'Ignored', value: 'Nothing' },
    { label: 'Exceptions', value: 'None' },
  ])
})

test('policyFacts and exceptedCount read the review, dev and exception parts', () => {
  const summary = {
    allow: ['MIT'],
    deny: [],
    ignore: [],
    unknown: 'warn' as const,
    requireProjectLicense: false,
    overrides: 0,
    review: ['MPL-*'],
    devDependencies: 'ignore' as const,
    exceptions: [{ package: 'fooUtil', reason: 'Licensed by contract.' }],
  }
  expect(policyFacts(summary).slice(-3)).toEqual([
    { label: 'Dev-only dependencies', value: 'Ignored' },
    { label: 'Ignored', value: 'Nothing' },
    { label: 'Exceptions', value: '1 package' },
  ])
  const verdicts = {
    allowed: 1,
    unknown: 0,
    unlisted: 0,
    denied: 0,
    ignored: 0,
    internal: 0,
    excepted: 2,
  }
  expect(exceptedCount({ verdicts })).toBe(2)
})

const licenseEntry = (id: string, value: unknown): SettingView => ({
  id,
  key: 'analyzers.licenses',
  scope: { groups: ['web'] },
  value,
  secret: false,
  updatedAt: '2026-11-01T00:00:00.000Z',
})

test('license exceptions go into the entries that apply, or a new one where defaults do', () => {
  const entry = licenseEntry
  const web = entry('s-1', {
    preset: 'permissive',
    exceptions: [{ package: 'old-lib', reason: 'x' }],
  })
  const hidden = entry('s-2', {})
  const winners = new Map<string, SettingView | null>([
    ['work:acme/a', web],
    ['work:acme/b', web],
    ['work:acme/c', null],
    ['work:acme/d', hidden],
  ])
  const { targets, blocked } = exceptionTargets(
    ['work:acme/a', 'work:acme/b', 'work:acme/c', 'work:acme/d'],
    winners,
    [web],
  )
  expect(blocked).toEqual(['work:acme/d'])
  expect(targets.map((target) => [target.settingId, target.reaches])).toEqual([
    ['s-1', ['work:acme/a', 'work:acme/b']],
    [undefined, ['work:acme/c']],
  ])
  const next = withLicenseException(targets[0]!.value, {
    package: 'old-lib',
    reason: 'Licensed by contract.',
    expires: '2027-01-01',
  })
  expect(next).toEqual({
    preset: 'permissive',
    exceptions: [{ package: 'old-lib', reason: 'Licensed by contract.', expires: '2027-01-01' }],
  })
})
