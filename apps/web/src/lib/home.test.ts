import { describe, expect, test } from 'bun:test'

import type { HomeAttentionItem, HomeView, RepoSummary } from '@holtkeeper/api'

import {
  attentionRows,
  groupAttention,
  fleetCounts,
  fleetTicks,
  inScope,
  repoHealth,
  scopeHome,
  spendSegments,
} from './home.ts'

const attention = (id: string, extra: Partial<HomeAttentionItem> = {}): HomeAttentionItem => ({
  id,
  kind: 'job-failures',
  severity: 'high',
  title: 'Widgets failed',
  repos: [{ repo: 'work:shapes/circle', groups: ['shapes'] }],
  count: 1,
  at: '2026-10-30T11:00:00.000Z',
  href: '/ops/runs',
  action: { type: 'open', label: 'View runs', href: '/ops/runs' },
  ...extra,
})

const home: Pick<HomeView, 'attention' | 'changes'> = {
  attention: [
    attention('a'),
    attention('b', {
      kind: 'knowledge',
      severity: 'low',
      title: '1 knowledge proposal',
      repos: [],
      href: '/inbox?kind=note',
    }),
  ],
  changes: [
    {
      id: 'e1',
      kind: 'release',
      text: 'Cut version 1.4.0 of colors/red',
      href: '/releases/timeline?repo=work%3Acolors%2Fred',
      at: '2026-10-30T10:00:00.000Z',
      actor: 'user:1',
      repo: { repo: 'work:colors/red', groups: ['colors'] },
    },
  ],
}

const summary = (
  path: string,
  health: RepoSummary['health'],
  cells: RepoSummary['cells'] = {},
  freshness?: RepoSummary['freshness'],
): RepoSummary => ({
  repo: { forge: 'work', path },
  groups: ['shapes'],
  health,
  cells,
  ...(freshness && { freshness }),
})

const cell = (tone: 'ok' | 'warn' | 'bad' | 'info' | 'none') => ({ value: tone, sub: '', tone })

describe('scopeHome', () => {
  test('My teams keeps rows of home-group repositories and rows about no repository', () => {
    const mine = scopeHome(home, 'mine', ['shapes'])
    expect(mine.attention.map((item) => item.id)).toEqual(['a', 'b'])
    expect(mine.changes).toEqual([])
  })

  test('All keeps everything', () => {
    expect(scopeHome(home, 'all', ['shapes']).changes).toHaveLength(1)
  })

  test('a row about several repositories belongs where any of them does', () => {
    const refs = [
      { repo: 'work:shapes/circle', groups: ['shapes'] },
      { repo: 'work:colors/red', groups: ['colors'] },
    ]
    expect(inScope(refs, 'mine', ['shapes'])).toBe(true)
    expect(inScope([refs[1]!], 'mine', ['shapes'])).toBe(false)
  })
})

test('snoozed attention rows move after the rest, order kept otherwise', () => {
  const rows = attentionRows([
    attention('a', { snoozed: true }),
    attention('b'),
    attention('c', { snoozed: true }),
    attention('d'),
  ])
  expect(rows.map((row) => row.id)).toEqual(['b', 'd', 'a', 'c'])
})

describe('repoHealth', () => {
  test('ranks by health, then by the score of the cells, then by path', () => {
    const ranked = repoHealth([
      summary('shapes/square', 'healthy', { jobs: cell('ok') }),
      summary('shapes/circle', 'warnings', { jobs: cell('warn') }),
      summary('shapes/oval', 'failing', { jobs: cell('bad') }),
      summary('shapes/star', 'not-analysed'),
      summary('shapes/cube', 'failing', { jobs: cell('bad'), coverage: cell('warn') }),
      summary('shapes/cone', 'warnings', { jobs: cell('warn') }),
    ])
    expect(ranked.map((entry) => entry.summary.repo.path)).toEqual([
      'shapes/cube',
      'shapes/oval',
      'shapes/circle',
      'shapes/cone',
      'shapes/star',
      'shapes/square',
    ])
    expect(ranked[0]).toMatchObject({ key: 'work:shapes/cube', score: 11 })
  })

  test('a failing repository outranks a warning one with more warnings', () => {
    const ranked = repoHealth([
      summary('a', 'warnings', {
        jobs: cell('warn'),
        ci: cell('warn'),
        coverage: cell('warn'),
        licenses: cell('warn'),
      }),
      summary('b', 'failing', { security: cell('bad') }),
    ])
    expect(ranked.map((entry) => entry.key)).toEqual(['work:b', 'work:a'])
  })

  test('ticks follow the ranking', () => {
    expect(fleetTicks(repoHealth([summary('a', 'healthy'), summary('b', 'not-analysed')]))).toEqual(
      [
        { tone: 'skipped', label: 'b: Not analysed' },
        { tone: 'success', label: 'a: Healthy' },
      ],
    )
  })
})

describe('fleetCounts', () => {
  test('counts repositories per status and sums stale analyses', () => {
    expect(
      fleetCounts([
        summary('a', 'healthy', {}, { current: 5, total: 5 }),
        summary('b', 'healthy', {}, { current: 3, total: 5 }),
        summary('c', 'failing', {}, { current: 0, total: 4 }),
        summary('d', 'not-analysed'),
      ]),
    ).toEqual({
      repos: 4,
      byStatus: { failing: 1, warnings: 0, 'not-analysed': 1, healthy: 2 },
      staleAnalyses: 6,
    })
  })

  test('an empty fleet counts zero everywhere', () => {
    expect(fleetCounts([])).toEqual({
      repos: 0,
      byStatus: { failing: 0, warnings: 0, 'not-analysed': 0, healthy: 0 },
      staleAnalyses: 0,
    })
  })
})

describe('spendSegments', () => {
  test('sums task kinds per feature, the largest darkest first, then the rest as Other', () => {
    const segments = spendSegments(
      {
        byFeature: [
          { feature: 'write-task', costUsd: 4, runs: 2 },
          { feature: 'review', costUsd: 3, runs: 2 },
          { feature: 'fix', costUsd: 2, runs: 1 },
          { feature: 'chat', costUsd: 1, runs: 4 },
          { feature: 'other', costUsd: 0.25, runs: 1 },
          { feature: 'guide', costUsd: 0.5, runs: 3 },
        ],
      },
      2,
    )
    expect(segments.map(({ label, costUsd, runs }) => ({ label, costUsd, runs }))).toEqual([
      { label: 'Agent tasks', costUsd: 6, runs: 3 },
      { label: 'Reviews', costUsd: 3, runs: 2 },
      { label: 'Other', costUsd: 1.75, runs: 8 },
    ])
    expect(segments.map((segment) => segment.color)).toEqual([
      'color-mix(in oklab, var(--fg) 88%, var(--raise))',
      'color-mix(in oklab, var(--fg) 64%, var(--raise))',
      'color-mix(in oklab, var(--fg) 14%, var(--raise))',
    ])
  })
})

describe('groupAttention', () => {
  const items = [
    attention('a', { severity: 'medium', repos: [{ repo: 'work:shapes/square', groups: [] }] }),
    attention('b', { severity: 'critical', kind: 'vulnerabilities' }),
    attention('c', { severity: 'low', kind: 'knowledge', repos: [] }),
    attention('d', { severity: 'critical', snoozed: true }),
  ]

  test('severity groups run worst first and leave snoozed rows out', () => {
    expect(
      groupAttention(items, 'severity').map((group) => [
        group.label,
        group.items.map((item) => item.id),
      ]),
    ).toEqual([
      ['Critical', ['b']],
      ['Medium', ['a']],
      ['Low', ['c']],
    ])
  })

  test('snoozed rows come back on request, after the rest of their group', () => {
    expect(groupAttention(items, 'severity', true)[0]!.items.map((item) => item.id)).toEqual([
      'b',
      'd',
    ])
  })

  test('kind groups keep row order and repository groups put rows about no repository last', () => {
    expect(groupAttention(items, 'kind').map((group) => group.label)).toEqual([
      'Job failure',
      'Vulnerability',
      'Knowledge',
    ])
    expect(groupAttention(items, 'repo').map((group) => group.label)).toEqual([
      'shapes/circle',
      'shapes/square',
      'No repository',
    ])
  })
})
