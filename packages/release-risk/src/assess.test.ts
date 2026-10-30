import { describe, expect, test } from 'bun:test'

import { assessRisk, riskLevel, testAreas } from './assess.ts'
import type { DepgraphView, QualityView } from './inputs.ts'
import { audit, bundle, changelog, commit, finding, source } from './test-helpers.ts'

const factorOf = (result: ReturnType<typeof assessRisk>, id: string) => {
  const found = result.factors.find((factor) => factor.id === id)
  if (!found) throw new Error(`no factor ${id}`)
  return found
}

const quality = (issues: QualityView['issues'], tests: QualityView['tests'] = []): QualityView => ({
  issues,
  tests,
})

const issue = (id: string, severity: 'error' | 'warning') => ({
  id,
  severity,
  message: id,
  rule: 'no-x',
  file: 'a.ts',
})

const graph = (cycles: string[][], duplicates: string[]): DepgraphView => ({
  layers: [
    {
      id: 'packages',
      cycles: cycles.map((members) => ({ members, path: [...members, members[0]!] })),
      duplicates: duplicates.map((name) => ({
        ecosystem: 'npm',
        name,
        versions: [{ version: '1.0.0' }, { version: '2.0.0' }],
      })),
    },
  ],
})

describe('assessRisk', () => {
  test('without inputs: score 0, nothing known, confidence 0, every input missing', () => {
    const result = assessRisk({})
    expect(result.score).toBe(0)
    expect(result.level).toBe('low')
    expect(result.confidence).toBe(0)
    expect(result.factors.every((factor) => !factor.known && factor.points === 0)).toBe(true)
    expect(result.missing.map((item) => item.input)).toContain('changelog')
    expect(result.missing).toHaveLength(9)
  })

  test('breaking changes and reverts score with commit evidence links', () => {
    const data = changelog(
      [
        commit('a1', 'feat!: drop v1 api', {
          type: 'feat',
          breaking: true,
          description: 'drop v1 api',
        }),
        commit('b2', 'Revert "feat: x"', { revert: { subject: 'feat: x' } }),
        commit('c3', 'fix: typo', { type: 'fix', description: 'typo' }),
      ],
      { links: { commit: 'https://git.example/c/{sha}' } },
    )
    const result = assessRisk({ changelog: source('changelog', 'cl1', data, 'v1.1.0') })
    const breaking = factorOf(result, 'breaking')
    expect(breaking.points).toBe(14)
    expect(breaking.tone).toBe('bad')
    expect(breaking.detail).toBe('1 breaking change, 1 revert.')
    expect(breaking.evidence[0]).toEqual({ label: 'drop v1 api', href: 'https://git.example/c/a1' })
    expect(breaking.evidence.at(-1)).toEqual({ label: 'changelog v1.1.0', href: '/analyses/cl1' })
    expect(result.ref).toBe('v1.1.0')
  })

  test('size uses the net diff when present and ignores merges', () => {
    const merge = { ...commit('m', 'Merge branch x'), parents: ['a', 'b'] }
    const data = changelog([commit('a', 'feat: a', { type: 'feat' }), merge], {
      diff: { files: 80, insertions: 1500, deletions: 500 },
    })
    const size = factorOf(assessRisk({ changelog: source('changelog', 'c', data) }), 'size')
    expect(size.detail).toBe('1 commit, +1500/-500 lines in 80 files.')
    expect(size.points).toBe(5)
  })

  test('bundle growth against the previous release and new heavy packages', () => {
    const result = assessRisk({
      bundle: source('bundle', 'b2', bundle(110_000, [{ name: 'moment', gzip: 20_000 }]), 'v2'),
      previousBundle: source('bundle', 'b1', bundle(100_000), 'v1'),
    })
    const growth = factorOf(result, 'bundle')
    expect(growth.points).toBe(15)
    expect(growth.detail).toContain('(+10.0%) against v1')
    expect(growth.detail).toContain('moment (19.5 kB)')
    expect(growth.evidence.map((item) => item.href)).toEqual(['/analyses/b2', '/analyses/b1'])
  })

  test('a shrinking bundle scores nothing; without a previous bundle the factor is unknown', () => {
    const shrink = assessRisk({
      bundle: source('bundle', 'b2', bundle(90_000)),
      previousBundle: source('bundle', 'b1', bundle(100_000)),
    })
    expect(factorOf(shrink, 'bundle')).toMatchObject({ points: 0, tone: 'good', known: true })
    const alone = factorOf(assessRisk({ bundle: source('bundle', 'b2', bundle(90_000)) }), 'bundle')
    expect(alone.known).toBe(false)
    expect(alone.detail).toContain('87.9 kB gzip')
  })

  test('only new high and critical vulnerabilities count', () => {
    const old = finding('GHSA-old', 'critical')
    const result = assessRisk({
      audit: source(
        'audit',
        'run2',
        audit([old, finding('GHSA-new', 'high'), finding('GHSA-low', 'low')]),
      ),
      previousAudit: source('audit', 'run1', audit([old])),
    })
    const vulns = factorOf(result, 'vulnerabilities')
    expect(vulns.points).toBe(10)
    expect(vulns.detail).toBe('1 new high vulnerability; 3 open in total.')
    expect(vulns.evidence[0]).toEqual({
      label: 'GHSA-new in lib',
      href: 'https://osv.dev/GHSA-new',
    })
    expect(vulns.evidence.at(-1)?.href).toBe('/audits')
  })

  test('without an earlier audit every open finding counts as new', () => {
    const result = assessRisk({ audit: source('audit', 'r', audit([finding('X', 'critical')])) })
    const vulns = factorOf(result, 'vulnerabilities')
    expect(vulns.points).toBe(25)
    expect(vulns.tone).toBe('bad')
    expect(vulns.detail).toContain('all count as new')
  })

  test('changed files with test gaps, and the coverage fallback', () => {
    const gaps = quality(
      [],
      [
        { file: 'src/a.ts', symbol: 'parse', reason: 'untested' },
        { file: 'src/b.ts', symbol: 'other', reason: 'untested' },
      ],
    )
    const withFiles = assessRisk({
      changelog: source('changelog', 'c', changelog([], { files: ['src/a.ts', 'README.md'] })),
      quality: source('quality', 'q', gaps),
    })
    const untested = factorOf(withFiles, 'untested')
    expect(untested.points).toBe(3)
    expect(untested.detail).toBe('1 changed file with untested code: src/a.ts.')
    expect(withFiles.testAreas.at(-1)).toEqual({
      area: 'src/a.ts',
      reasons: ['changed without tests: parse'],
      tone: 'warning',
      commits: 0,
    })

    const coverage = assessRisk({
      quality: source('quality', 'q', {
        ...gaps,
        coverage: { lines: { covered: 40, total: 100 } },
      }),
    })
    expect(factorOf(coverage, 'untested')).toMatchObject({ points: 4, known: true })
  })

  test('new cycles and duplicates against the previous graph', () => {
    const result = assessRisk({
      depgraph: source(
        'depgraph',
        'd2',
        graph(
          [
            ['a', 'b'],
            ['c', 'd'],
          ],
          ['react', 'lodash'],
        ),
      ),
      previousDepgraph: source('depgraph', 'd1', graph([['b', 'a']], ['react'])),
    })
    const deps = factorOf(result, 'dependencies')
    expect(deps.detail).toBe('1 new cycle, 1 new duplicated library (lodash).')
    expect(deps.points).toBe(5)
  })

  test('new quality errors by stable issue id', () => {
    const result = assessRisk({
      quality: source(
        'quality',
        'q2',
        quality([issue('1', 'error'), issue('2', 'error'), issue('3', 'warning')]),
      ),
      previousQuality: source('quality', 'q1', quality([issue('1', 'error')])),
    })
    const q = factorOf(result, 'quality')
    expect(q.detail).toBe('1 new error, 1 new warning.')
    expect(q.points).toBe(1)
    expect(q.evidence[0]?.label).toBe('no-x in a.ts: 2')
  })

  test('contributors and hotspot scopes', () => {
    const commits = [
      ...Array.from({ length: 5 }, (_, i) =>
        commit(`a${i}`, `fix(auth): f${i}`, { type: 'fix', scope: 'auth' }, `dev${i}`),
      ),
      commit('z', 'feat: z', { type: 'feat' }, 'dev9'),
    ]
    const result = assessRisk({ changelog: source('changelog', 'c', changelog(commits)) })
    const people = factorOf(result, 'contributors')
    expect(people.detail).toBe('6 contributors; busiest areas: auth (5 commits).')
    expect(people.points).toBe(4)
  })

  test('weights replace defaults; score is capped at 100 and confidence sums input shares', () => {
    const result = assessRisk(
      {
        audit: source('audit', 'r', audit([finding('A', 'critical'), finding('B', 'critical')])),
        changelog: source(
          'changelog',
          'c',
          changelog([
            commit('a', 'feat!: x', { breaking: true }),
            commit('b', 'feat!: y', { breaking: true }),
          ]),
        ),
      },
      { vulnerabilities: 80, breaking: 50 },
    )
    expect(result.score).toBe(100)
    expect(result.level).toBe('critical')
    expect(result.confidence).toBe(0.5)
  })

  test('unreadable inputs keep their reason', () => {
    const result = assessRisk({ unreadable: [{ input: 'quality', reason: 'broken record' }] })
    expect(result.missing.find((item) => item.input === 'quality')?.reason).toBe('broken record')
  })
})

test('riskLevel thresholds', () => {
  expect([0, 24, 25, 49, 50, 74, 75, 100].map(riskLevel)).toEqual([
    'low',
    'low',
    'medium',
    'medium',
    'high',
    'high',
    'critical',
    'critical',
  ])
})

test('testAreas groups user-facing changes by scope, riskiest first', () => {
  const areas = testAreas({
    changelog: source(
      'changelog',
      'c',
      changelog([
        commit('1', 'feat(cart): coupons', { type: 'feat', scope: 'cart', description: 'coupons' }),
        commit('2', 'fix(cart): totals', { type: 'fix', scope: 'Cart', description: 'totals' }),
        commit('3', 'docs: readme', { type: 'docs' }),
        commit('4', 'feat(api)!: v2', {
          type: 'feat',
          scope: 'api',
          breaking: true,
          description: 'v2',
        }),
        commit('5', 'misc change'),
        commit('6', 'wip', { wip: true }),
      ]),
    ),
  })
  expect(areas).toEqual([
    { area: 'api', reasons: ['v2'], tone: 'bad', commits: 1 },
    { area: 'cart', reasons: ['coupons', 'totals'], tone: 'warning', commits: 2 },
    { area: 'General', reasons: ['misc change'], tone: 'neutral', commits: 1 },
  ])
})
