import { beforeEach, describe, expect, test } from 'bun:test'

import type { RepoTarget } from '@holtkeeper/access'
import { auditAnalysis } from '@holtkeeper/analyzers'
import type { ReleaseCard } from '@holtkeeper/api'
import { coverageAnalysis } from '@holtkeeper/coverage'
import type { AnalysisHead, Job, SettingEntry, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'

import {
  type HealthAccess,
  type HealthSources,
  healthOf,
  indexSources,
  readHealthSources,
  repoHealth,
} from '../src/repo-health.ts'

const NOW = new Date('2026-10-30T12:00:00.000Z')
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString()

const circle: RepoTarget = { forge: 'work', path: 'shapes/circle', groups: ['shapes'] }
const square: RepoTarget = { forge: 'work', path: 'shapes/square', groups: ['shapes'] }

const head = (kind: string, metrics?: object, patch: Partial<AnalysisHead> = {}): AnalysisHead => ({
  id: `${kind}-${Math.random().toString(36).slice(2)}`,
  repo: { forge: 'work', path: 'shapes/circle' },
  kind,
  createdAt: hoursAgo(1),
  ...(metrics && { metrics }),
  ...patch,
})

const severities = (patch: Record<string, number> = {}) => ({
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  unknown: 0,
  ...patch,
})

const audit = (patch: Record<string, number> = {}, extra: object = {}) =>
  head('audit', {
    findings: 0,
    severities: severities(patch),
    ignored: 0,
    expired: 0,
    resolved: 0,
    ...extra,
  })

const job = (status: Job['status'], patch: Partial<Job> = {}): Job => ({
  id: `job-${Math.random().toString(36).slice(2)}`,
  analyzer: 'widgets',
  repo: { forge: 'work', path: 'shapes/circle' },
  options: {},
  trigger: 'schedule',
  status,
  attempts: 1,
  maxAttempts: 1,
  runAfter: hoursAgo(2),
  createdAt: hoursAgo(2),
  finishedAt: hoursAgo(1),
  attemptsHistory: [],
  ...patch,
})

const auditRun = (finishedAt: string, patch: Record<string, number>) => ({
  id: `run-${finishedAt}`,
  repo: { forge: 'work', path: 'shapes/circle' },
  trigger: 'cli' as const,
  startedAt: finishedAt,
  finishedAt,
  severities: severities(patch),
  active: 1,
  ignored: 0,
  resolved: 0,
  expiredAllowlist: 0,
  languages: [],
  tools: [],
  changedFiles: 0,
})

const card = (patch: Partial<ReleaseCard>): ReleaseCard => ({
  repo: { forge: 'work', path: 'shapes/circle' },
  stage: 'idle',
  mode: 'merge-request',
  ahead: 0,
  aheadCapped: false,
  unreleased: 0,
  unreleasedCapped: false,
  tickets: [],
  pipelines: {},
  blockers: [],
  acceptanceRequired: false,
  reasons: [],
  leftOut: 0,
  tasks: 0,
  environments: [],
  needsAction: false,
  can: { accept: false, run: false },
  ...patch,
})

const setting = (key: string, scope: SettingEntry['scope'], value: unknown): SettingEntry => ({
  id: `${key}-${JSON.stringify(scope)}`,
  key,
  scope,
  value,
  secret: false,
  updatedAt: hoursAgo(10),
})

const sources = (patch: Partial<HealthSources> = {}): HealthSources => ({
  now: NOW,
  settings: [],
  heads: [],
  jobs: [],
  releases: [],
  ...patch,
})

const all = () => true

const classify = (patch: Partial<HealthSources>, repo = circle, access: HealthAccess = all) =>
  repoHealth(indexSources(sources(patch)), repo, access)

const cellOf = (key: string, patch: Partial<HealthSources>) => {
  const cells = classify(patch).cells as Record<string, unknown>
  return cells[key]
}

describe('repoHealth cells', () => {
  test('security counts the worst severity of the audit metrics', () => {
    expect(
      cellOf('security', { heads: [audit({ critical: 1, high: 2 }, { ignored: 1 })] }),
    ).toEqual({ value: '1 critical', sub: '2 high · 1 allowlisted', tone: 'bad' })
    expect(cellOf('security', { heads: [audit({ high: 2 })] })).toMatchObject({
      value: '2 high',
      tone: 'bad',
    })
    expect(cellOf('security', { heads: [audit({ low: 1 }, { expired: 2 })] })).toEqual({
      value: 'Allowlist expired',
      sub: '2 entries',
      tone: 'warn',
    })
    expect(cellOf('security', { heads: [audit({ medium: 1, low: 2 })] })).toEqual({
      value: '1 medium',
      sub: '2 lower',
      tone: 'warn',
    })
    expect(cellOf('security', { heads: [audit()] })).toEqual({
      value: 'None',
      sub: '0 findings',
      tone: 'ok',
    })
    expect(cellOf('security', {})).toEqual({ value: '—', sub: 'no record', tone: 'none' })
  })

  test('security reads an ingested audit run newer than the audit record', () => {
    expect(cellOf('security', { audits: [auditRun(hoursAgo(2), { critical: 1 })] })).toMatchObject({
      value: '1 critical',
      tone: 'bad',
    })
    expect(
      cellOf('security', { heads: [audit()], audits: [auditRun(hoursAgo(0), { high: 3 })] }),
    ).toMatchObject({ value: '3 high' })
    expect(
      cellOf('security', { heads: [audit()], audits: [auditRun(hoursAgo(5), { high: 3 })] }),
    ).toMatchObject({ value: 'None' })
  })

  test('coverage is judged by the target of the most specific analyzers.coverage entry', () => {
    const heads = [
      head('coverage', { percent: 58.4, delta: 0.4, target: 60, files: 3, untested: 0 }),
    ]
    expect(cellOf('coverage', { heads })).toEqual({ value: '58%', sub: 'below 60%', tone: 'bad' })
    const settings = [
      setting('analyzers.coverage', { groups: ['shapes'] }, { target: 70 }),
      setting('analyzers.coverage', { repos: ['work:shapes/circle'] }, { target: 50 }),
    ]
    expect(cellOf('coverage', { heads, settings })).toEqual({
      value: '58%',
      sub: '+0.4 pt',
      tone: 'ok',
    })
    expect(
      cellOf('coverage', {
        heads: [head('coverage', { percent: 80, delta: -1.5, target: 60, files: 3, untested: 0 })],
      }),
    ).toEqual({ value: '80%', sub: '−1.5 pt', tone: 'warn' })
    expect(
      cellOf('coverage', { heads: [head('coverage', { target: 60, files: 0, untested: 0 })] }),
    ).toMatchObject({
      tone: 'none',
    })
  })

  test('a repository with no tests by design gets a neutral coverage cell', () => {
    const heads = [head('coverage', { percent: 12, delta: -4, target: 60, files: 3, untested: 2 })]
    const settings = [
      setting('repo.tests', { groups: ['shapes'] }, { expected: false, reason: 'Config only' }),
    ]
    expect(cellOf('coverage', { heads, settings })).toEqual({
      value: 'No tests',
      sub: 'Config only',
      tone: 'none',
    })
    expect(classify({ heads, settings }).health).not.toBe('failing')
    expect(
      cellOf('coverage', {
        settings: [setting('repo.tests', { groups: ['shapes'] }, { expected: false })],
      }),
    ).toEqual({ value: 'No tests', sub: 'by design', tone: 'none' })
  })

  test('a cell whose analyzer is turned off is a neutral Off with the reason', () => {
    const heads = [audit()]
    const settings = [
      setting('repo.analyzers', { groups: ['shapes'] }, { off: ['audit'], reason: 'Values only' }),
    ]
    expect(cellOf('security', { heads, settings })).toEqual({
      value: 'Off',
      sub: 'Values only',
      tone: 'none',
    })
    expect(classify({ heads, settings }).health).not.toBe('failing')
    expect(
      cellOf('bundles', {
        settings: [setting('repo.analyzers', { groups: ['shapes'] }, { off: ['bundle'] })],
      }),
    ).toEqual({ value: 'Off', sub: 'turned off for this repository', tone: 'none' })
  })

  test('bundles sum gzip per target and check the budgets of analyzers.bundle', () => {
    const heads = [
      head('bundle', {
        targets: [
          { name: 'app', source: 'build', status: 'ok', gzip: 380_000, delta: 1_200 },
          { name: '@acme/widget-kit', source: 'package', status: 'ok', gzip: 32_000, delta: 0 },
        ],
        failed: 0,
      }),
    ]
    expect(cellOf('bundles', { heads })).toEqual({ value: '402 kB', sub: '+1.2 kB', tone: 'ok' })
    const near = [setting('analyzers.bundle', { all: true }, { budgets: { app: 400_000 } })]
    expect(cellOf('bundles', { heads, settings: near })).toEqual({
      value: '402 kB',
      sub: '1 target near budget',
      tone: 'warn',
    })
    const over = [setting('analyzers.bundle', { all: true }, { budgets: { '@acme/*': 30_000 } })]
    expect(cellOf('bundles', { heads, settings: over })).toEqual({
      value: '402 kB',
      sub: '1 target over budget',
      tone: 'bad',
    })
    const stored = [
      head('bundle', {
        targets: [
          {
            name: 'app',
            source: 'build',
            status: 'ok',
            gzip: 380_000,
            budget: 400_000,
            verdict: 'near',
          },
        ],
        failed: 0,
      }),
    ]
    expect(cellOf('bundles', { heads: stored })).toMatchObject({ sub: '1 target near budget' })
    const grown = [
      head('bundle', {
        targets: [{ name: 'app', source: 'build', status: 'ok', gzip: 1_200_000, delta: 200_000 }],
        failed: 0,
      }),
    ]
    expect(cellOf('bundles', { heads: grown })).toEqual({
      value: '1.1 MB',
      sub: '+20%',
      tone: 'warn',
    })
  })

  test('jobs count analyzers whose latest run of the last day failed', () => {
    expect(
      cellOf('jobs', {
        jobs: [
          job('failed', { analyzer: 'graph' }),
          job('succeeded'),
          job('failed'),
          job('failed', { analyzer: 'old', finishedAt: hoursAgo(30) }),
          job('failed', { group: 'shapes', repo: { forge: 'work', path: 'shapes' } }),
        ],
      }),
    ).toEqual({ value: '1 failed', sub: 'last 24 hours', tone: 'bad' })
    expect(cellOf('jobs', { jobs: [job('blocked')] })).toEqual({
      value: '1 blocked',
      sub: 'AI budget',
      tone: 'warn',
    })
    expect(cellOf('jobs', { jobs: [job('running'), job('succeeded')] })).toMatchObject({
      value: 'Running',
      tone: 'info',
    })
    expect(cellOf('jobs', { jobs: [job('succeeded')] })).toEqual({
      value: 'OK',
      sub: '',
      tone: 'ok',
    })
    expect(cellOf('jobs', {})).toEqual({ value: 'No jobs', sub: '', tone: 'none' })
  })

  test('ci, licenses and dependencies read their kinds metrics', () => {
    const ci = (metrics: object) => cellOf('ci', { heads: [head('ci-jobs', metrics)] })
    expect(
      ci({ status: 'healthy', pipelines: 4, median: 250, failing: 0, flaky: 0, slower: 0 }),
    ).toEqual({
      value: 'Passing',
      sub: '4m 10s',
      tone: 'ok',
    })
    expect(ci({ status: 'flaky', pipelines: 4, failing: 0, flaky: 3, slower: 0 })).toEqual({
      value: 'Flaky',
      sub: '3 flaky jobs',
      tone: 'warn',
    })
    expect(
      ci({
        status: 'healthy',
        pipelines: 4,
        median: 250,
        queue: 46,
        failing: 0,
        flaky: 0,
        slower: 0,
      }),
    ).toMatchObject({ sub: '4m 10s · queue 46s' })
    expect(ci({ status: 'failing', pipelines: 4, failing: 1, flaky: 0, slower: 0 })).toEqual({
      value: 'Failing',
      sub: '1 job',
      tone: 'bad',
    })
    expect(
      ci({ status: 'failing', pipelines: 4, successRate: 71.3, failing: 2, flaky: 0, slower: 0 }),
    ).toMatchObject({ sub: '2 jobs · 71.3% pass' })

    const licenses = (verdicts: Record<string, number>, extra: object = {}) =>
      cellOf('licenses', {
        heads: [
          head('licenses', {
            packages: 10,
            verdicts: {
              allowed: 0,
              unknown: 0,
              unlisted: 0,
              denied: 0,
              ignored: 0,
              internal: 0,
              ...verdicts,
            },
            violations: 0,
            missingProjectLicense: false,
            ...extra,
          }),
        ],
      })
    expect(licenses({ allowed: 10 })).toEqual({ value: 'OK', sub: '10 packages', tone: 'ok' })
    expect(licenses({ unknown: 1 })).toEqual({ value: '1 to review', sub: '', tone: 'warn' })
    expect(licenses({ denied: 2 }, { violations: 2 })).toMatchObject({
      value: '2 denied',
      tone: 'bad',
    })

    const deps = (metrics: object) => cellOf('dependencies', { heads: [head('renovate', metrics)] })
    expect(deps({ outdated: 4, major: 0, security: 0 })).toEqual({
      value: '4 behind',
      sub: 'minor or patch',
      tone: 'ok',
    })
    expect(deps({ outdated: 4, major: 0, security: 0, minor: 3, patch: 0 })).toMatchObject({
      sub: 'minor only',
    })
    expect(deps({ outdated: 2, major: 0, security: 0, minor: 0, patch: 2 })).toMatchObject({
      sub: 'patch only',
    })
    expect(deps({ outdated: 7, major: 2, security: 0 })).toEqual({
      value: '7 behind',
      sub: '2 major',
      tone: 'warn',
    })
    expect(deps({ outdated: 12, major: 0, security: 0 })).toMatchObject({ tone: 'warn' })
    expect(deps({ outdated: 3, major: 0, security: 1 })).toEqual({
      value: '3 behind',
      sub: '1 security fix',
      tone: 'bad',
    })
    expect(deps({ outdated: 0 })).toEqual({ value: 'Up to date', sub: '', tone: 'ok' })
    expect(cellOf('dependencies', { heads: [head('renovate')] })).toMatchObject({ tone: 'none' })
  })

  test('release follows the stored card', () => {
    const release = (patch: Partial<ReleaseCard>) => cellOf('release', { releases: [card(patch)] })
    expect(release({ stage: 'proposed', needsAction: true })).toEqual({
      value: 'Waiting',
      sub: 'acceptance',
      tone: 'warn',
    })
    expect(release({ stage: 'proposed', needsAction: true, next: 'v2.8.0' })).toMatchObject({
      sub: 'v2.8.0 · acceptance',
    })
    expect(release({ stage: 'candidate', needsAction: true, unreleased: 14 })).toEqual({
      value: 'Ready',
      sub: '14 unreleased commits',
      tone: 'info',
    })
    expect(
      release({
        stage: 'candidate',
        needsAction: true,
        unreleased: 4,
        next: 'v5.3.0',
        latest: { tag: 'v5.2.0', version: '5.2.0', sha: 'abc' },
      }),
    ).toEqual({ value: 'Ready', sub: 'v5.2.0 → v5.3.0', tone: 'info' })
    expect(release({ unreleased: 14 })).toEqual({
      value: 'Waiting',
      sub: '14 commits unreleased',
      tone: 'warn',
    })
    expect(
      release({
        needsAction: true,
        deploy: {
          tag: 'v1.2.0',
          environments: [{ name: 'prod', status: 'failed', attempts: [], confirm: false }],
        },
      }),
    ).toEqual({ value: 'Deploy failed', sub: 'v1.2.0 · prod', tone: 'bad' })
    expect(release({ latest: { tag: 'v0.9.3', version: '0.9.3', sha: 'abc' } })).toEqual({
      value: 'Released',
      sub: 'v0.9.3',
      tone: 'ok',
    })
    expect(
      release({ latest: { tag: 'v0.9.3', version: '0.9.3', sha: 'abc', date: hoursAgo(8 * 24) } }),
    ).toMatchObject({ sub: 'v0.9.3 · 1w' })
    expect(cellOf('release', {})).toEqual({ value: 'Off', sub: 'not set up', tone: 'none' })
  })
})

describe('repoHealth', () => {
  test('leaves out cells, freshness and the last analysis the access denies', () => {
    const patch = {
      heads: [
        audit({ high: 1 }),
        head('coverage', { percent: 90, target: 60, files: 1, untested: 0 }),
      ],
      releases: [card({ stage: 'proposed', needsAction: true })],
    }
    const audits = classify(patch, circle, (action) => action === 'audits:read')
    expect(Object.keys(audits.cells)).toEqual(['security'])
    expect(audits.health).toBe('failing')
    expect(audits.freshness).toBeUndefined()
    expect(audits.lastAnalysedAt).toBeUndefined()

    const analyses = classify(patch, circle, (action) => action === 'analyses:read')
    expect(Object.keys(analyses.cells)).toEqual([
      'dependencies',
      'coverage',
      'bundles',
      'jobs',
      'ci',
      'licenses',
    ])
    expect(analyses.health).toBe('healthy')
    expect(analyses.freshness).toEqual({ current: 2, total: 2 })
    expect(analyses.lastAnalysedAt).toBe(hoursAgo(1))

    expect(classify(patch, circle, () => false)).toEqual({ health: 'not-analysed', cells: {} })
  })

  test('a repository without records is not analysed; old records are not current', () => {
    expect(classify({}, square).health).toBe('not-analysed')
    const old = classify({ heads: [head('coverage', undefined, { createdAt: hoursAgo(15 * 24) })] })
    expect(old.freshness).toEqual({ current: 0, total: 1 })
  })

  test('test analyses of a repository with no tests by design are left out of freshness', () => {
    const heads = [
      audit(),
      head(
        'coverage',
        { percent: 10, target: 60, files: 1, untested: 1 },
        {
          createdAt: hoursAgo(30 * 24),
        },
      ),
    ]
    const settings = [setting('repo.tests', { groups: ['shapes'] }, { expected: false })]
    expect(classify({ heads, settings }).freshness).toEqual({ current: 1, total: 1 })
    expect(classify({ heads }).freshness).toEqual({ current: 1, total: 2 })
  })

  test('records of analyzers turned off are left out of freshness', () => {
    const heads = [
      head('audit', undefined, { createdAt: hoursAgo(30 * 24) }),
      head('ci-jobs', { status: 'idle' }),
    ]
    const settings = [setting('repo.analyzers', { groups: ['shapes'] }, { off: ['audit'] })]
    expect(classify({ heads, settings }).freshness).toEqual({ current: 1, total: 1 })
    expect(classify({ heads }).freshness).toEqual({ current: 1, total: 2 })
  })

  test('healthOf takes the worst tone', () => {
    const ok = { value: 'OK', sub: '', tone: 'ok' as const }
    expect(healthOf({ jobs: ok, ci: { ...ok, tone: 'warn' } })).toBe('warnings')
    expect(healthOf({ jobs: ok, ci: { ...ok, tone: 'info' } })).toBe('healthy')
    expect(healthOf({ jobs: { ...ok, tone: 'none' } })).toBe('not-analysed')
  })
})

describe('readHealthSources', () => {
  let store: Store
  beforeEach(() => {
    store = memoryStore()
  })

  test('reads settings once and computes metrics of records stored without them', async () => {
    await store.analyses.add({
      repo: { forge: 'work', path: 'shapes/circle' },
      kind: 'audit',
      createdAt: hoursAgo(1),
      data: {
        scanner: 'osv-scanner',
        findings: [
          {
            id: 'GHSA-1',
            aliases: [],
            summary: 'widget overflow',
            severity: 'high',
            url: 'https://osv.dev/GHSA-1',
            package: { name: 'some-lib', version: '1.0.0', ecosystem: 'npm' },
            source: 'pnpm-lock.yaml',
            fixedVersions: [],
          },
        ],
        ignored: [],
        expired: [],
        fixes: [],
        resolved: [],
        changedFiles: [],
      },
    })
    let lists = 0
    const counted: Store = {
      ...store,
      settings: {
        ...store.settings,
        list: async (key) => {
          lists += 1
          return store.settings.list(key)
        },
      },
    }
    const read = await readHealthSources(
      { store: counted, analyses: [auditAnalysis], now: () => NOW },
      { jobRepos: [] },
    )
    const indexed = indexSources(read)
    expect(repoHealth(indexed, circle, all).cells.security).toMatchObject({ value: '1 high' })
    expect(repoHealth(indexed, square, all).cells.security).toMatchObject({ tone: 'none' })
    expect(lists).toBe(1)
  })

  test('a newer run on another branch does not become the repository health', async () => {
    const coverage = (percent: number, createdAt: string, ref?: string) =>
      store.analyses.add({
        repo: { forge: 'work', path: 'shapes/circle' },
        kind: 'coverage',
        createdAt,
        ...(ref ? { ref } : {}),
        data: {},
        metrics: { percent, target: 60, files: 1, untested: 0 },
      })
    await coverage(90, hoursAgo(5))
    await coverage(20, hoursAgo(1), 'feature/wip')
    const read = await readHealthSources(
      { store, analyses: [coverageAnalysis], now: () => NOW },
      { jobRepos: [] },
    )
    const health = repoHealth(indexSources(read), circle, all)
    expect(health.cells.coverage).toMatchObject({ value: '90%', tone: 'ok' })
    expect(health.health).toBe('healthy')
  })
})
