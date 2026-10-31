import { describe, expect, test } from 'bun:test'

import type { RenovateData } from '@holtkeeper/renovate'
import type { AnalysisRecord } from '@holtkeeper/store'

import { dependencyUpdatesOverview } from '../src/dependency-updates.ts'

const now = new Date('2026-10-31T12:00:00Z')

const renovate = (overrides: Partial<RenovateData> = {}): RenovateData => ({
  status: 'ok',
  mode: 'merge-requests',
  readOnly: false,
  renovateVersion: '44.164.10',
  startedAt: '2026-10-31T02:00:00Z',
  durationMs: 1000,
  dependencies: 10,
  outdated: 0,
  managers: [],
  updates: [],
  deprecated: [],
  mergeRequests: [],
  problems: [],
  output: '',
  ...overrides,
})

const update = (dependency: string, type: 'major' | 'minor', extra = {}) => ({
  dependency,
  manager: 'npm',
  file: 'package.json',
  current: '1.0.0',
  next: type === 'major' ? '2.0.0' : '1.1.0',
  type,
  vulnerability: false,
  pending: false,
  ...extra,
})

let id = 0
const record = (path: string, kind: string, data: unknown, createdAt = '2026-10-31T02:00:00Z') =>
  ({
    id: `r${++id}`,
    repo: { forge: 'work', path },
    kind,
    createdAt,
    data,
  }) as AnalysisRecord

describe('dependencyUpdatesOverview', () => {
  const records = [
    record(
      'games/broken',
      'renovate',
      renovate({
        outdated: 1,
        updates: [update('react', 'major', { mergeRequest: 4 })],
        mergeRequests: [
          {
            id: 4,
            title: 'Update react to v19',
            branch: 'renovate/react',
            state: 'open',
            draft: false,
            pipeline: 'failed',
            types: ['major'],
            updates: 1,
          },
          {
            id: 2,
            title: 'Update lodash',
            branch: 'renovate/lodash',
            state: 'merged',
            draft: false,
            types: ['patch'],
            updates: 1,
            mergedAt: '2026-10-20T00:00:00Z',
          },
          {
            id: 1,
            title: 'Old one',
            branch: 'renovate/old',
            state: 'merged',
            draft: false,
            types: ['patch'],
            updates: 1,
            mergedAt: '2026-08-01T00:00:00Z',
          },
        ],
      }),
    ),
    record('games/old', 'renovate', renovate({ status: 'failed' }), '2026-10-01T00:00:00Z'),
    record(
      'games/old',
      'renovate',
      renovate({
        mode: 'report',
        outdated: 2,
        updates: [update('react', 'major'), update('vite', 'minor', { vulnerability: true })],
      }),
    ),
    record('games/current', 'renovate', renovate()),
    record('games/browser', 'browserslist', {
      status: 'updated',
      before: ['1.0.30001600'],
      after: ['1.0.30001700'],
      targets: [],
      files: ['bun.lock'],
      mergeRequest: { id: 3, url: 'https://forge.test/mr/3', draft: false },
      dryRun: false,
      output: '',
      startedAt: '2026-10-31T02:00:00Z',
    }),
    record('games', 'propagation', {
      group: 'games',
      packages: [{ name: '@games/ui', ecosystem: 'npm', requested: 'latest', version: '3.0.0' }],
      dryRun: false,
      releaseNotes: [],
      repos: [
        {
          repo: 'games/current',
          status: 'unchanged',
          usages: [],
          bumps: [],
          checks: [],
          attempts: 0,
          changedFiles: [],
          fixedFiles: [],
          notes: [],
        },
        {
          repo: 'games/ui-user',
          status: 'fixed',
          usages: [],
          bumps: [],
          checks: [],
          attempts: 1,
          changedFiles: [],
          fixedFiles: [],
          notes: [],
          mergeRequest: { id: 8, url: 'https://forge.test/mr/8', draft: false },
        },
      ],
    }),
    record('games/bad', 'renovate', { not: 'renovate data' }),
  ]

  test('one row per repository, worst state first', () => {
    const overview = dependencyUpdatesOverview({ records, now })
    expect(overview.repos.map((r) => [r.repo.path, r.state])).toEqual([
      ['games/broken', 'broken'],
      ['games/browser', 'review'],
      ['games/ui-user', 'review'],
      ['games/old', 'outdated'],
      ['games/current', 'current'],
    ])
    expect(overview.totals).toEqual({
      repos: 5,
      broken: 1,
      review: 2,
      outdated: 1,
      current: 1,
      unknown: 0,
      openMergeRequests: 3,
      merged: 1,
      security: 1,
    })
  })

  test('merge requests of every source, recent merges only', () => {
    const rows = Object.fromEntries(
      dependencyUpdatesOverview({ records, now }).repos.map((r) => [r.repo.path, r]),
    )
    expect(rows['games/broken']?.mergeRequests.map((mr) => [mr.id, mr.status])).toEqual([
      [4, 'broken'],
      [2, 'merged'],
    ])
    expect(rows['games/browser']?.mergeRequests[0]).toMatchObject({
      source: 'browserslist',
      status: 'review',
    })
    expect(rows['games/ui-user']).toMatchObject({
      propagation: { packages: ['@games/ui'], status: 'fixed' },
      mergeRequests: [{ source: 'propagate', id: 8, title: 'Update @games/ui', status: 'review' }],
    })
    expect(rows['games/old']?.renovate).toMatchObject({ mode: 'report', majors: 1, security: 1 })
  })

  test('dependencies most repositories lag behind on, security first', () => {
    expect(dependencyUpdatesOverview({ records, now }).dependencies).toEqual([
      {
        dependency: 'vite',
        manager: 'npm',
        repos: ['work:games/old'],
        majors: 0,
        security: true,
        latest: '1.1.0',
      },
      {
        dependency: 'react',
        manager: 'npm',
        repos: ['work:games/broken', 'work:games/old'],
        majors: 2,
        security: false,
        latest: '2.0.0',
      },
    ])
  })

  test('leaves out repositories the caller may not read', () => {
    const overview = dependencyUpdatesOverview({
      records,
      now,
      visible: (repo) => repo.path !== 'games/broken',
    })
    expect(overview.repos.map((r) => r.repo.path)).not.toContain('games/broken')
    expect(overview.dependencies.find((d) => d.dependency === 'react')?.repos).toEqual([
      'work:games/old',
    ])
  })
})
