import { describe, expect, test } from 'bun:test'

import type { EnvironmentSummary, ReleaseCard } from '@holtkeeper/api'

import {
  actionFirst,
  environmentColumns,
  environmentTag,
  environmentTicks,
  filterOverview,
  nextStep,
  overviewCounts,
  overviewSortValue,
  overviewState,
  overviewStateText,
  overviewTag,
  queueCounts,
  queueRows,
  targetPipeline,
  withEnvironments,
} from './release-overview.ts'

const env = (name: string, extra: Partial<EnvironmentSummary> = {}): EnvironmentSummary => ({
  name,
  status: 'success',
  ...extra,
})

const card = (path: string, extra: Partial<ReleaseCard> = {}): ReleaseCard => ({
  repo: { forge: 'gitlab', path },
  stage: 'released',
  mode: 'merge-request',
  source: 'develop',
  target: 'main',
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
  ...extra,
})

describe('overviewState', () => {
  test('an error comes before everything else', () => {
    const row = card('acme/widget-kit', {
      error: 'Token expired',
      stage: 'awaiting-version',
      environments: [env('staging', { status: 'failed' })],
    })
    expect(overviewState(row)).toBe('unread')
    expect(overviewTag(row)).toEqual({ label: 'Could not read the forge', tone: 'danger' })
  })

  test('a failed deploy names its environment', () => {
    const row = card('acme/ledger-api', {
      stage: 'awaiting-version',
      environments: [env('staging', { status: 'failed' }), env('production')],
    })
    expect(overviewState(row)).toBe('deploy-failed')
    expect(overviewStateText(row)).toBe('Deploy to staging failed')
  })

  test('a version waits for acceptance only when the flow needs one and nobody accepted', () => {
    const waiting = card('acme/widget-kit', { stage: 'awaiting-version', acceptanceRequired: true })
    expect(overviewState(waiting)).toBe('acceptance')
    const accepted = {
      ...waiting,
      acceptance: { sha: 'abc1234', by: 'u1', at: '2026-11-10T10:00:00Z', via: 'manual' as const },
    }
    expect(overviewState(accepted)).toBe('ready-to-tag')
    expect(overviewState(card('acme/notify-svc', { stage: 'awaiting-version' }))).toBe(
      'ready-to-tag',
    )
  })

  test('pending steps come before deploys, deploys before the stage', () => {
    expect(overviewState(card('a/b', { stage: 'proposed' }))).toBe('proposed')
    expect(overviewState(card('a/b', { stage: 'candidate' }))).toBe('candidate')
    const ready = card('a/b', { environments: [env('production', { status: 'ready' })] })
    expect(overviewState(ready)).toBe('deploy-ready')
    const running = card('a/b', { environments: [env('production', { status: 'running' })] })
    expect(overviewState(running)).toBe('deploying')
    expect(overviewStateText(running)).toBe('Deploying to production')
    expect(overviewState(card('a/b', { stage: 'idle' }))).toBe('idle')
    expect(overviewTag(card('a/b', { stage: 'idle' })).tone).toBe('default')
  })
})

describe('order', () => {
  test('rows needing action first, then by state, then by path', () => {
    const rows = [
      card('acme/zeta', { stage: 'released' }),
      card('acme/beta', { stage: 'proposed', needsAction: true }),
      card('acme/alpha', { stage: 'proposed', needsAction: true }),
      card('acme/gamma', { stage: 'awaiting-version', needsAction: true }),
      card('acme/delta', { stage: 'awaiting-version', needsAction: false }),
    ]
    expect(actionFirst(rows).map((row) => row.repo.path)).toEqual([
      'acme/gamma',
      'acme/alpha',
      'acme/beta',
      'acme/delta',
      'acme/zeta',
    ])
  })

  test('sort values by column', () => {
    const row = card('acme/widget-kit', {
      latest: { tag: 'v4.2.1', version: '4.2.1', sha: 'abc', date: '2026-11-06T10:00:00Z' },
      next: '4.3.0',
      unreleased: 14,
      pipelines: {
        target: { id: 1, status: 'failed', sha: 'abc', webUrl: 'https://example.test/p/1' },
      },
    })
    expect(overviewSortValue(row, 'repo')).toBe('acme/widget-kit')
    expect(overviewSortValue(row, 'latest')).toEqual(new Date('2026-11-06T10:00:00Z'))
    expect(overviewSortValue(row, 'next')).toBe('4.3.0')
    expect(overviewSortValue(row, 'unreleased')).toBe(14)
    expect(overviewSortValue(row, 'ci')).toBe(0)
    expect(overviewSortValue(card('a/b'), 'ci')).toBeUndefined()
    expect(overviewSortValue(card('a/b', { error: 'x' }), 'stage')).toBe(0)
  })
})

test('filterOverview matches path and versions', () => {
  const rows = [
    card('acme/widget-kit', { next: '4.3.0' }),
    card('acme/ledger-api', {
      latest: { tag: 'v3.14.0', version: '3.14.0', sha: 'def' },
    }),
  ]
  expect(filterOverview(rows, ' WIDGET ').map((row) => row.repo.path)).toEqual(['acme/widget-kit'])
  expect(filterOverview(rows, '4.3').map((row) => row.repo.path)).toEqual(['acme/widget-kit'])
  expect(filterOverview(rows, 'v3.14').map((row) => row.repo.path)).toEqual(['acme/ledger-api'])
  expect(filterOverview(rows, '')).toHaveLength(2)
})

test('overviewCounts', () => {
  const rows = [
    card('a/1', {
      stage: 'awaiting-version',
      acceptanceRequired: true,
      needsAction: true,
      unreleased: 14,
    }),
    card('a/2', { stage: 'proposed', needsAction: true, unreleased: 300, unreleasedCapped: true }),
    card('a/3', { environments: [env('prod', { status: 'running' })] }),
    card('a/4', { environments: [env('prod', { status: 'failed' })], needsAction: true }),
    card('a/5', { error: 'Token expired', needsAction: true }),
  ]
  expect(overviewCounts(rows)).toEqual({
    repos: 5,
    needsAction: 4,
    acceptance: 1,
    proposed: 1,
    deploying: 1,
    deployFailed: 1,
    unread: 1,
    unreleased: 314,
    unreleasedCapped: true,
  })
})

describe('queue', () => {
  const rows = [
    card('acme/widget-kit', {
      stage: 'awaiting-version',
      acceptanceRequired: true,
      needsAction: true,
    }),
    card('acme/notify-svc', { stage: 'awaiting-version', needsAction: true }),
    card('acme/storefront', { stage: 'proposed', needsAction: true }),
    card('acme/http-client', { stage: 'proposed', needsAction: false }),
    card('acme/admin-console'),
  ]

  test('keeps rows needing action, narrowed by state', () => {
    expect(queueRows(rows).map((row) => row.repo.path)).toEqual([
      'acme/widget-kit',
      'acme/notify-svc',
      'acme/storefront',
    ])
    expect(queueRows(rows, 'proposed').map((row) => row.repo.path)).toEqual(['acme/storefront'])
  })

  test('counts per filter', () => {
    expect(queueCounts(rows)).toEqual({
      action: 3,
      acceptance: 1,
      'ready-to-tag': 1,
      proposed: 1,
      'deploy-failed': 0,
    })
  })
})

describe('nextStep', () => {
  test('a forge error leads to the credentials', () => {
    expect(nextStep(card('a/b', { error: 'Token expired' }))).toEqual({
      label: 'Check the forge',
      to: 'integrations',
      action: true,
    })
  })

  test('Accept only when the caller may accept', () => {
    const waiting = card('a/b', {
      stage: 'awaiting-version',
      acceptanceRequired: true,
      next: '4.3.0',
    })
    expect(nextStep(waiting)).toEqual({ label: 'Review changes', to: 'timeline', action: false })
    expect(nextStep({ ...waiting, can: { accept: true, run: true } })).toEqual({
      label: 'Accept 4.3.0',
      to: 'timeline',
      action: true,
    })
  })

  test('one step per state', () => {
    const label = (extra: Partial<ReleaseCard>) => nextStep(card('a/b', extra)).label
    expect(label({ environments: [env('staging', { status: 'failed' })] })).toBe('Retry staging')
    expect(label({ stage: 'awaiting-version', next: '1.10.0' })).toBe('Create 1.10.0')
    expect(label({ stage: 'awaiting-version' })).toBe('Create version')
    expect(
      label({
        stage: 'proposed',
        request: {
          id: 412,
          title: 'Release 5.7.0',
          webUrl: 'https://example.test/mr/412',
          draft: false,
        },
      }),
    ).toBe('Review !412')
    expect(label({ stage: 'candidate' })).toBe('Open release MR')
    expect(label({ environments: [env('production', { status: 'ready' })] })).toBe(
      'Deploy to production',
    )
    expect(nextStep(card('a/b', { environments: [env('prod', { status: 'running' })] }))).toEqual({
      label: 'Follow the deploy',
      to: 'timeline',
      action: false,
    })
    expect(nextStep(card('a/b'))).toEqual({ label: 'Open timeline', to: 'timeline', action: false })
  })
})

describe('environments', () => {
  test('union of names in first-seen order, columns up to three', () => {
    const rows = [
      card('a/1', { environments: [env('staging'), env('production')] }),
      card('a/2', { environments: [env('review'), env('staging')] }),
    ]
    expect(environmentColumns(rows)).toEqual({
      names: ['staging', 'production', 'review'],
      ticks: false,
    })
    expect(environmentColumns([])).toEqual({ names: [], ticks: false })
  })

  test('more than three collapse to a tick strip', () => {
    const rows = [
      card('a/1', { environments: [env('dev'), env('staging')] }),
      card('a/2', { environments: [env('canary'), env('production')] }),
    ]
    expect(environmentColumns(rows).ticks).toBe(true)
  })

  test('keeps rows that deploy to a chosen environment', () => {
    const rows = [
      card('a/1', { environments: [env('staging'), env('production')] }),
      card('a/2', { environments: [env('review')] }),
      card('a/3'),
    ]
    expect(withEnvironments(rows, ['production', 'review']).map((row) => row.repo.path)).toEqual([
      'a/1',
      'a/2',
    ])
    expect(withEnvironments(rows, [])).toHaveLength(3)
  })

  test('a ready environment warns and a waiting one stays neutral', () => {
    expect(environmentTag('ready')).toEqual({ label: 'Ready', tone: 'warning' })
    expect(environmentTag('waiting')).toEqual({ label: 'Waiting', tone: 'default' })
  })

  test('ticks per name with the running version, neutral where missing', () => {
    const row = card('a/1', {
      environments: [
        env('staging', { status: 'success', version: '4.2.1' }),
        env('production', { status: 'waiting' }),
      ],
    })
    expect(environmentTicks(row, ['staging', 'production', 'canary'])).toEqual([
      { tone: 'success', label: 'staging: Deployed · 4.2.1' },
      { tone: 'skipped', label: 'production: Waiting' },
      { tone: 'skipped', label: 'canary: not configured' },
    ])
  })
})

test('targetPipeline', () => {
  expect(targetPipeline(card('a/b'))).toEqual({ label: 'Not read', tone: 'none' })
  expect(
    targetPipeline(
      card('a/b', {
        pipelines: {
          target: { id: 1, status: 'success', sha: 'abc', webUrl: 'https://example.test' },
        },
      }),
    ),
  ).toEqual({ label: 'Passed', tone: 'success' })
})
