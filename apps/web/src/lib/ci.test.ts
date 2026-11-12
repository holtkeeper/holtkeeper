import { describe, expect, test } from 'bun:test'

import type { CiJobStats, CiRepoCard } from '@holtkeeper/api'

import {
  changeLabel,
  ciKpis,
  ciSort,
  ciSortValue,
  failureTone,
  filterCiCards,
  moreFlagged,
  outcomeBar,
  parseCiSearch,
  releaseGateText,
  seconds,
  stageBars,
  successTone,
  unreliableJobs,
  withCiSort,
  worstCiFirst,
} from './ci.ts'

const job = (name: string, stage: string, extra: Partial<CiJobStats> = {}): CiJobStats => ({
  name,
  stage,
  runs: 10,
  pipelines: 10,
  failures: 0,
  retryRate: 0,
  flaky: 0,
  allowFailure: false,
  duration: { samples: 10, median: 60 },
  trend: 'stable',
  weeks: [],
  last: { at: '2026-10-01T00:00:00.000Z', status: 'success', href: `https://ci.test/${name}` },
  ...extra,
})

const card = (path: string, extra: Partial<CiRepoCard> = {}): CiRepoCard => ({
  repo: { forge: 'acme', path },
  analysisId: `id-${path}`,
  createdAt: '2026-11-12T03:00:00.000Z',
  pipelines: 100,
  weeks: [],
  problems: 0,
  groups: ['Web'],
  status: 'healthy',
  flakyJobs: 0,
  ...extra,
})

describe('ci helpers', () => {
  test('durations and tones', () => {
    expect(seconds(185)).toBe('3 min 5 s')
    expect(seconds(undefined)).toBe('—')
    expect([failureTone(undefined), failureTone(4), failureTone(10), failureTone(30)]).toEqual([
      'success',
      'success',
      'warning',
      'danger',
    ])
    expect([successTone(undefined), successTone(98), successTone(70)]).toEqual([
      'default',
      'success',
      'danger',
    ])
  })

  test('a slower pipeline reads as bad, a small change stays neutral', () => {
    expect(changeLabel(12.4)).toEqual({ text: '↑ 12%', tone: 'danger' })
    expect(changeLabel(-8)).toEqual({ text: '↓ 8%', tone: 'success' })
    expect(changeLabel(3)).toEqual({ text: '↑ 3%', tone: 'default' })
    expect(changeLabel(0.2)).toEqual({ text: '± 0%', tone: 'default' })
    expect(changeLabel(undefined).text).toBe('')
  })

  test('unreliable jobs: worst failure rate first, then most flaky', () => {
    const list = unreliableJobs([
      job('fine', 'a'),
      job('flaky', 'a', { flaky: 3 }),
      job('broken', 'a', { failures: 4, failureRate: 40 }),
      job('wobbly', 'a', { flaky: 1 }),
    ])
    expect(list.map((j) => j.name)).toEqual(['broken', 'flaky', 'wobbly'])
  })
})

test('stage bars follow the run order, scale to the slowest p90 and carry flags', () => {
  const bars = stageBars(
    {
      stages: ['prepare', 'check'],
      jobs: [
        job('unit', 'check', { duration: { samples: 5, median: 60, p90: 120 } }),
        job('lint', 'check', { duration: { samples: 5, median: 30 } }),
        job('compile', 'prepare', { duration: { samples: 5, median: 90, p90: 240 } }),
        job('notes', 'extra', { duration: { samples: 0 } }),
      ],
    },
    { unit: ['flaky'] },
  )
  expect(bars.map((bar) => [bar.stage, bar.first, bar.job])).toEqual([
    ['prepare', true, 'compile'],
    ['check', true, 'unit'],
    ['check', false, 'lint'],
    ['extra', true, 'notes'],
  ])
  expect(bars[1]).toMatchObject({ medianWidth: 25, p90Width: 50, flags: ['flaky'] })
  expect(bars[2]).toMatchObject({ medianWidth: 13, p90Width: 13 })
  expect(bars[3]).toMatchObject({ medianWidth: 0, p90Width: 0 })
})

test('worst first: state, then success rate, then path', () => {
  expect(
    worstCiFirst([
      card('acme/b'),
      card('acme/a', { status: 'flaky', successRate: 95 }),
      card('acme/c', { status: 'failing' }),
      card('acme/d', { status: 'flaky', successRate: 80 }),
      card('acme/e', { status: 'idle' }),
    ]).map((c) => c.repo.path),
  ).toEqual(['acme/c', 'acme/d', 'acme/a', 'acme/b', 'acme/e'])
})

test('KPIs: medians of repositories, pipeline-weighted success, flaky sum and states', () => {
  const kpis = ciKpis([
    card('acme/a', {
      median: 100,
      p90: 200,
      successRate: 90,
      pipelines: 100,
      flakyJobs: 2,
      queueMedian: 10,
    }),
    card('acme/b', {
      median: 300,
      p90: 400,
      successRate: 50,
      pipelines: 300,
      status: 'failing',
      queueMedian: 30,
    }),
    card('acme/c', { pipelines: 0, status: 'idle' }),
  ])
  expect(kpis).toMatchObject({
    repos: 3,
    median: 200,
    p90: 300,
    successRate: 60,
    flakyJobs: 2,
    queueMedian: 20,
    statuses: { failing: 1, flaky: 0, slower: 0, healthy: 1, idle: 1 },
  })
  expect(ciKpis([]).successRate).toBeUndefined()
})

test('filters and sort values', () => {
  const cards = [
    card('acme/checkout-web', {
      problems: 2,
      status: 'flaky',
      lastRunAt: '2026-11-12T01:00:00.000Z',
    }),
    card('acme/ledger-api', { groups: ['Payments'] }),
  ]
  expect(filterCiCards(cards, { q: 'payments' }).map((c) => c.repo.path)).toEqual([
    'acme/ledger-api',
  ])
  expect(filterCiCards(cards, { status: ['flaky'] }).map((c) => c.repo.path)).toEqual([
    'acme/checkout-web',
  ])
  expect(filterCiCards(cards, { problems: true })).toHaveLength(1)
  const [first, second] = cards
  if (!first || !second) throw new Error('cards missing')
  expect(ciSortValue(first, 'status')).toBe(1)
  expect(ciSortValue(first, 'last')).toEqual(new Date('2026-11-12T01:00:00.000Z'))
  expect(ciSortValue(second, 'last')).toBeUndefined()
  expect(ciSortValue(second, 'repo')).toBe('acme:acme/ledger-api')
})

test('outcome bar, extra flags and the release gate in words', () => {
  expect(outcomeBar({ success: 355, failed: 41, canceled: 16 })?.label).toBe(
    'Passed 355 · 86.2% · Failed 41 · Canceled 16',
  )
  expect(outcomeBar({ success: 0, failed: 0, canceled: 0 })).toBeUndefined()
  expect(outcomeBar(undefined)).toBeUndefined()
  expect(
    moreFlagged({ unit: ['flaky', 'slower'], lint: ['failing'] }, [{ job: 'unit', kind: 'flaky' }]),
  ).toEqual([
    { job: 'lint', kinds: ['failing'] },
    { job: 'unit', kinds: ['slower'] },
  ])
  expect(releaseGateText({ pipeline: true, branch: 'main' })).toBe('Pipeline must pass on main')
  expect(releaseGateText({ pipeline: false, branch: 'main' })).toContain('do not wait')
})

test('CI search keeps known values only', () => {
  expect(
    parseCiSearch({
      repo: 'acme:acme/widgets',
      tab: 'x',
      q: 'web',
      status: 'flaky,odd',
      problems: 'true',
      sort: 'median',
      dir: 'desc',
    }),
  ).toEqual({
    repo: 'acme:acme/widgets',
    q: 'web',
    status: ['flaky'],
    problems: true,
    sort: 'median',
    dir: 'desc',
  })
  expect(parseCiSearch({ repo: 1, problems: 'no', sort: 'odd' })).toEqual({})
  expect(ciSort({ sort: 'p90' })).toEqual({ key: 'p90', direction: 'asc' })
  expect(withCiSort({ sort: 'p90', dir: 'asc', q: 'a' }, null)).toEqual({ q: 'a' })
})
