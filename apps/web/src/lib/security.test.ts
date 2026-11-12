import { describe, expect, test } from 'bun:test'

import type { AuditRunSummary, FindingGroup, FindingRepo, SettingView } from '@holtkeeper/api'

import {
  allowlistRows,
  allowlistState,
  allowlistTargets,
  filterFindings,
  filterRuns,
  findingCounts,
  findingEcosystems,
  findingKey,
  findingRows,
  fixPrompt,
  fixSource,
  inDays,
  isFutureDay,
  fixTargets,
  installedVersions,
  parseSecuritySearch,
  repoStatusCounts,
  scopeCovers,
  sortFindings,
  statusNote,
  withAllowlistEntry,
} from './security.ts'

const repo = (key: string, status: FindingRepo['status'] = 'open', groups = ['web']) => ({
  repo: key,
  groups,
  versions: ['3.2.1'],
  sources: ['pnpm-lock.yaml'],
  status,
})

const group = (overrides: Partial<FindingGroup> = {}): FindingGroup => ({
  advisory: 'GHSA-aaaa-bbbb-cccc',
  aliases: ['CVE-2026-0001'],
  summary: 'Prototype pollution in deep merge',
  package: 'fooUtil',
  ecosystem: 'npm',
  severity: 'high',
  fixedIn: ['3.2.4', '2.8.5'],
  repos: [repo('gitlab:acme/checkout-web')],
  status: 'open',
  firstSeenAt: '2026-11-06T10:00:00Z',
  ...overrides,
})

const setting = (id: string, scope: SettingView['scope'], value: unknown): SettingView => ({
  id,
  key: 'audit.allowlist',
  scope,
  value,
  secret: false,
  updatedAt: '2026-10-01T00:00:00Z',
})

const ids = (list: FindingGroup[]) => list.map((g) => g.advisory)

const run = (id: string, trigger: AuditRunSummary['trigger'], active: number) =>
  ({ id, trigger, active }) as AuditRunSummary

test('parseSecuritySearch keeps known values and drops defaults', () => {
  expect(
    parseSecuritySearch({
      view: 'runs',
      repo: 'gitlab:acme/storefront',
      runs: 'all',
      trigger: 'schedule',
      findings: 'open',
      severity: 'high,critical,nope',
      status: ['open', 'fixing'],
      ecosystem: 'npm,Go',
      sort: 'seen',
      q: 'fooUtil',
      finding: 'GHSA-aaaa-bbbb-cccc:fooUtil',
      tab: 'repos',
    }),
  ).toEqual({
    view: 'runs',
    repo: 'gitlab:acme/storefront',
    runs: 'all',
    trigger: 'schedule',
    findings: 'open',
    severity: ['high', 'critical'],
    status: ['open', 'fixing'],
    ecosystem: ['npm', 'Go'],
    sort: 'seen',
    q: 'fooUtil',
    finding: 'GHSA-aaaa-bbbb-cccc:fooUtil',
    tab: 'repos',
  })
})

test('parseSecuritySearch drops unknown and default values', () => {
  expect(
    parseSecuritySearch({
      view: 'findings',
      sort: 'severity',
      runs: 'some',
      trigger: 'robot',
      findings: 'maybe',
      severity: '',
      repo: '',
    }),
  ).toEqual({})
  expect(parseSecuritySearch({ view: 'all' })).toEqual({})
})

describe('findings', () => {
  const groups = [
    group(),
    group({
      advisory: 'GO-2026-0002',
      aliases: [],
      package: 'some-lib/xml',
      ecosystem: 'Go',
      severity: 'critical',
      repos: [repo('gitlab:acme/ledger-api', 'fixing', ['payments'])],
      status: 'fixing',
      taskId: 'task-1',
      firstSeenAt: '2026-11-01T00:00:00Z',
    }),
    group({
      advisory: 'GHSA-zzzz-yyyy-xxxx',
      aliases: [],
      package: 'zod',
      severity: 'low',
      repos: [
        repo('gitlab:acme/checkout-web', 'allowlisted'),
        repo('gitlab:acme/storefront', 'allowlisted'),
      ],
      status: 'allowlisted',
      firstSeenAt: '2026-11-10T00:00:00Z',
    }),
  ]

  const order = (sort: Parameters<typeof sortFindings>[1]) =>
    sortFindings(groups, sort).map((g) => g.package)

  test('filters by severity, status, ecosystem, repository and text', () => {
    expect(ids(filterFindings(groups, { severity: ['critical', 'low'] }))).toEqual([
      'GO-2026-0002',
      'GHSA-zzzz-yyyy-xxxx',
    ])
    expect(ids(filterFindings(groups, { status: ['open', 'fixing'] }))).toEqual([
      'GHSA-aaaa-bbbb-cccc',
      'GO-2026-0002',
    ])
    expect(ids(filterFindings(groups, { ecosystem: ['Go'] }))).toEqual(['GO-2026-0002'])
    expect(ids(filterFindings(groups, { repo: 'gitlab:acme/storefront' }))).toEqual([
      'GHSA-zzzz-yyyy-xxxx',
    ])
    expect(ids(filterFindings(groups, { q: 'cve-2026' }))).toEqual(['GHSA-aaaa-bbbb-cccc'])
    expect(ids(filterFindings(groups, { q: 'LEDGER' }))).toEqual(['GO-2026-0002'])
    expect(filterFindings(groups, {})).toHaveLength(3)
  })

  test('sorts by severity, repositories, first sighting and package', () => {
    expect(order('severity')).toEqual(['some-lib/xml', 'fooUtil', 'zod'])
    expect(order('repos')).toEqual(['zod', 'fooUtil', 'some-lib/xml'])
    expect(order('seen')).toEqual(['zod', 'fooUtil', 'some-lib/xml'])
    expect(order('package')).toEqual(['fooUtil', 'some-lib/xml', 'zod'])
  })

  test('counts groups per severity and status and distinct repositories', () => {
    expect(findingCounts(groups)).toEqual({
      groups: 3,
      repos: 3,
      severities: { critical: 1, high: 1, medium: 0, low: 1, unknown: 0 },
      status: { open: 1, fixing: 1, allowlisted: 1 },
    })
  })

  test('rows carry a key and the groups of their repositories', () => {
    const rows = findingRows(groups)
    expect(rows[0]?.key).toBe('GHSA-aaaa-bbbb-cccc:fooUtil')
    expect(rows[1]?.groups).toEqual(['payments'])
    expect(findingKey(groups[2]!)).toBe('GHSA-zzzz-yyyy-xxxx:zod')
    expect(findingEcosystems(groups)).toEqual(['Go', 'npm'])
  })

  test('status per repository and the note for mixed groups', () => {
    const mixed = group({
      repos: [
        repo('gitlab:acme/a', 'open'),
        repo('gitlab:acme/b', 'open'),
        repo('gitlab:acme/c', 'fixing'),
        { ...repo('gitlab:acme/d', 'allowlisted'), versions: ['3.1.8', '3.10.0'] },
      ],
    })
    expect(repoStatusCounts(mixed)).toEqual({ open: 2, fixing: 1, allowlisted: 1 })
    expect(statusNote(mixed)).toBe('2 open · 1 fixing · 1 allowlisted')
    expect(statusNote(group())).toBe('')
    expect(fixTargets(mixed)).toEqual(['gitlab:acme/a', 'gitlab:acme/b'])
    expect(installedVersions(mixed)).toEqual(['3.1.8', '3.2.1', '3.10.0'])
  })

  test('fix prompt names the advisory and the target version', () => {
    const prompt = fixPrompt(group())
    expect(prompt).toContain('GHSA-aaaa-bbbb-cccc (CVE-2026-0001)')
    expect(prompt).toContain('to 3.2.4 or later')
    expect(fixPrompt(group({ fixedIn: [] }))).toContain('No fixed version is published')
  })

  test('fix source is the dependency upgrade the findings join marks as fixing', () => {
    const fix = group()
    expect(fixSource(fix)).toEqual({
      type: 'dependency-upgrade',
      ecosystem: fix.ecosystem,
      package: fix.package,
      to: fix.fixedIn[0]!,
    })
    expect(fixSource(group({ fixedIn: [] }))).toBeUndefined()
  })
})

test('filterRuns keeps trigger and findings matches', () => {
  const runs = [run('a', 'schedule', 2), run('b', 'manual', 0), run('c', 'schedule', 0)]
  expect(filterRuns(runs, { trigger: 'schedule' }).map((r) => r.id)).toEqual(['a', 'c'])
  expect(filterRuns(runs, { findings: 'clean' }).map((r) => r.id)).toEqual(['b', 'c'])
  expect(filterRuns(runs, { findings: 'open', trigger: 'manual' })).toEqual([])
})

describe('allowlist', () => {
  test('state by last day', () => {
    expect(allowlistState(undefined, '2026-11-12')).toBe('permanent')
    expect(allowlistState('2026-11-11', '2026-11-12')).toBe('expired')
    expect(allowlistState('2026-11-12', '2026-11-12')).toBe('expiring')
    expect(allowlistState('2026-11-25', '2026-11-12')).toBe('expiring')
    expect(allowlistState('2026-11-26', '2026-11-12')).toBe('active')
  })

  test('scopes cover repositories by all, groups and patterns', () => {
    const target = { repo: 'gitlab:acme/checkout-web', groups: ['web', 'payments'] }
    expect(scopeCovers({ all: true }, target)).toBe(true)
    expect(scopeCovers({ groups: ['web'] }, target)).toBe(true)
    expect(scopeCovers({ groups: [['web', 'platform']] }, target)).toBe(false)
    expect(scopeCovers({ repos: ['gitlab:acme/*'] }, target)).toBe(true)
    expect(scopeCovers({ repos: ['github:acme/*'] }, target)).toBe(false)
    expect(scopeCovers({ repos: ['acme/checkout-web'] }, target)).toBe(true)
    expect(scopeCovers({ repos: ['acme/storefront'] }, target)).toBe(false)
  })

  test('rows list entries expired first with the repositories they hide', () => {
    const groups = [
      group({
        repos: [
          repo('gitlab:acme/checkout-web', 'allowlisted'),
          repo('gitlab:acme/storefront', 'open', ['shop']),
        ],
        status: 'open',
      }),
    ]
    const rows = allowlistRows(
      [
        setting('s1', { all: true }, [
          { id: 'CVE-2026-0001', reason: 'Not reachable', expires: '2026-12-31' },
          { id: 'GHSA-old', reason: 'Old', expires: '2026-11-01' },
          { bogus: true },
        ]),
        setting('s2', { groups: ['web'] }, [
          { id: 'GHSA-aaaa-bbbb-cccc', package: 'other-lib', reason: 'Other package' },
        ]),
        { ...setting('s3', { all: true }, []), key: 'audit.fix' },
      ],
      groups,
      new Date('2026-11-12T12:00:00Z'),
    )
    expect(rows.map((r) => [r.key, r.state, r.covers])).toEqual([
      ['s1#1', 'expired', []],
      ['s1#0', 'active', ['gitlab:acme/checkout-web']],
      ['s2#0', 'permanent', []],
    ])
  })

  test('targets are the applying entries, plus a new one only for uncovered repositories', () => {
    const org = setting('org', { all: true }, [{ id: 'X', reason: 'r' }])
    const web = setting('web', { groups: ['web'] }, [])
    const repos = ['gitlab:acme/checkout-web', 'gitlab:acme/storefront', 'gitlab:acme/ledger-api']
    const winners = new Map<string, SettingView | null>([
      ['gitlab:acme/checkout-web', web],
      ['gitlab:acme/storefront', web],
      ['gitlab:acme/ledger-api', org],
    ])
    const both = allowlistTargets(repos, winners, [org, web])
    expect(both.targets.map((t) => [t.settingId, t.reaches])).toEqual([
      ['web', ['gitlab:acme/checkout-web', 'gitlab:acme/storefront']],
      ['org', ['gitlab:acme/ledger-api']],
    ])
    expect(both.blocked).toEqual([])
    winners.set('gitlab:acme/ledger-api', null)
    expect(allowlistTargets(repos, winners, [web])).toEqual({
      targets: [
        {
          settingId: 'web',
          scope: { groups: ['web'] },
          entries: [],
          reaches: ['gitlab:acme/checkout-web', 'gitlab:acme/storefront'],
        },
        {
          scope: { repos: ['gitlab:acme/ledger-api'] },
          entries: [],
          reaches: ['gitlab:acme/ledger-api'],
        },
      ],
      blocked: [],
    })
  })

  test('a broader allowlist the caller cannot read blocks the repository instead of a new entry', () => {
    const org = setting('org', { all: true }, [{ id: 'X', reason: 'r' }])
    const repos = ['gitlab:acme/checkout-web', 'gitlab:acme/storefront']
    const winners = new Map([['gitlab:acme/checkout-web', org]])
    expect(allowlistTargets(repos, winners, [])).toEqual({
      targets: [],
      blocked: ['gitlab:acme/checkout-web', 'gitlab:acme/storefront'],
    })
  })

  test('day helpers count from now and accept days from today on', () => {
    expect(inDays(90, new Date('2026-11-10T12:00:00Z'))).toBe('2027-02-08')
    expect(isFutureDay('2026-11-10', '2026-11-10')).toBe(true)
    expect(isFutureDay('2026-11-09', '2026-11-10')).toBe(false)
    expect(isFutureDay('2026-11', '2026-11-10')).toBe(false)
  })

  test('adding an entry replaces one for the same advisory and package', () => {
    const entries = [
      { id: 'A', reason: 'old', package: 'zod' },
      { id: 'A', reason: 'other package', package: 'fooUtil' },
    ]
    expect(withAllowlistEntry(entries, { id: 'A', reason: 'new', package: 'zod' })).toEqual([
      { id: 'A', reason: 'other package', package: 'fooUtil' },
      { id: 'A', reason: 'new', package: 'zod' },
    ])
  })
})
