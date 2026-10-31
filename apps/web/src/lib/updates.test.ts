import { expect, test } from 'bun:test'

import type { RepoUpdates } from '@holtkeeper/api'

import { filterRepos, orderedMergeRequests, reportOnly, stateBreakdown } from './updates.ts'

const repo = (path: string, state: RepoUpdates['state'], extra: Partial<RepoUpdates> = {}) => ({
  repo: { forge: 'work', path },
  state,
  mergeRequests: [],
  ...extra,
})

const repos = [
  repo('games/a', 'broken'),
  repo('games/b', 'review'),
  repo('tools/c', 'current', {
    renovate: { mode: 'report' } as RepoUpdates['renovate'],
  }),
]

test('filters by state and by path', () => {
  expect(filterRepos(repos, { state: 'review' }).map((r) => r.repo.path)).toEqual(['games/b'])
  expect(filterRepos(repos, { query: 'GAMES' }).map((r) => r.repo.path)).toEqual([
    'games/a',
    'games/b',
  ])
  expect(filterRepos(repos, {})).toHaveLength(3)
})

test('breaks totals down by state, worst first, skipping empty states', () => {
  expect(
    stateBreakdown({
      repos: 4,
      broken: 1,
      review: 0,
      outdated: 2,
      current: 1,
      unknown: 0,
      openMergeRequests: 0,
      merged: 0,
      security: 0,
    }),
  ).toEqual([
    { state: 'broken', count: 1, share: 0.25 },
    { state: 'outdated', count: 2, share: 0.5 },
    { state: 'current', count: 1, share: 0.25 },
  ])
})

test('orders merge requests broken first, merged last', () => {
  const entry = repo('games/a', 'broken', {
    mergeRequests: [
      { source: 'renovate', id: 1, title: 'a', status: 'merged' },
      { source: 'renovate', id: 2, title: 'b', status: 'review' },
      { source: 'browserslist', id: 3, title: 'c', status: 'broken' },
    ],
  })
  expect(orderedMergeRequests(entry).map((mr) => mr.id)).toEqual([3, 2, 1])
})

test('counts repositories in report-only mode', () => {
  expect(reportOnly(repos)).toBe(1)
})
