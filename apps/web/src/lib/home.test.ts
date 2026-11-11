import { describe, expect, test } from 'bun:test'

import type { HomeRepoTile, HomeView } from '@holtkeeper/api'

import { featureLabel, inScope, repoTicks, scopeHome, spendSegments, tileRank } from './home.ts'

const tile = (
  repo: string,
  groups: string[],
  tones: HomeRepoTile['status'][number]['tone'][] = [],
) => ({
  repo,
  groups,
  status: tones.map((tone, index) => ({
    key: (['jobs', 'vulnerabilities', 'release', 'analyses'] as const)[index]!,
    tone,
    label: tone,
  })),
})

const home: HomeView = {
  generatedAt: '2026-10-30T12:00:00.000Z',
  attention: [
    {
      id: 'a',
      kind: 'job-failures',
      severity: 'high',
      title: 'Widgets failed',
      repos: [{ repo: 'work:shapes/circle', groups: ['shapes'] }],
      count: 1,
      at: '2026-10-30T11:00:00.000Z',
      href: '/jobs',
    },
    {
      id: 'b',
      kind: 'knowledge',
      severity: 'low',
      title: '1 knowledge proposal',
      repos: [],
      count: 1,
      at: '2026-10-30T11:00:00.000Z',
      href: '/knowledge',
    },
  ],
  changes: [
    {
      kind: 'release',
      text: '1 version cut',
      repo: { repo: 'work:colors/red', groups: ['colors'] },
      count: 1,
      actors: [],
      firstAt: '2026-10-30T10:00:00.000Z',
      lastAt: '2026-10-30T10:00:00.000Z',
    },
  ],
  changesDays: 7,
  repos: [tile('work:shapes/circle', ['shapes']), tile('work:colors/red', ['colors'])],
  people: {},
}

describe('scopeHome', () => {
  test('My team keeps rows of home-group repositories and rows about no repository', () => {
    const mine = scopeHome(home, 'mine', ['shapes'])
    expect(mine.attention.map((item) => item.id)).toEqual(['a', 'b'])
    expect(mine.changes).toEqual([])
    expect(mine.repos.map((t) => t.repo)).toEqual(['work:shapes/circle'])
    expect(mine.counts).toEqual({ mine: 1, all: 2, others: 1 })
  })

  test('Other teams keeps the rest, All everything', () => {
    expect(scopeHome(home, 'others', ['shapes']).attention.map((item) => item.id)).toEqual(['b'])
    expect(scopeHome(home, 'all', ['shapes']).changes).toHaveLength(1)
  })

  test('a row about several repositories belongs where any of them does', () => {
    const refs = [
      { repo: 'work:shapes/circle', groups: ['shapes'] },
      { repo: 'work:colors/red', groups: ['colors'] },
    ]
    expect(inScope(refs, 'mine', ['shapes'])).toBe(true)
    expect(inScope(refs, 'others', ['shapes'])).toBe(true)
    expect(inScope([refs[1]!], 'mine', ['shapes'])).toBe(false)
  })
})

describe('spendSegments', () => {
  test('the largest features, then the rest as Other', () => {
    expect(
      spendSegments(
        {
          byFeature: [
            { feature: 'review', costUsd: 5, runs: 2 },
            { feature: 'chat', costUsd: 3, runs: 4 },
            { feature: 'release-notes', costUsd: 1, runs: 1 },
          ],
        },
        2,
      ),
    ).toEqual([
      { value: 5, tone: 'accent', label: 'Review' },
      { value: 3, tone: 'info', label: 'Chat' },
      { value: 1, tone: 'default', label: 'Other' },
    ])
  })

  test('feature labels read as words', () => {
    expect(featureLabel('release-notes')).toBe('Release notes')
    expect(featureLabel('')).toBe('Other')
  })
})

describe('repo tiles', () => {
  test('ticks carry the status name and tone, tiles rank by their worst status', () => {
    const t = tile('work:shapes/circle', ['shapes'], ['ok', 'danger', 'none', 'warning'])
    expect(repoTicks(t)).toEqual([
      { tone: 'success', label: 'Jobs: ok' },
      { tone: 'danger', label: 'Vulnerabilities: danger' },
      { tone: 'skipped', label: 'Release: none' },
      { tone: 'warning', label: 'Analyses: warning' },
    ])
    expect(tileRank(t)).toBe(0)
    expect(tileRank(tile('x', [], ['ok', 'none']))).toBe(3)
  })
})
