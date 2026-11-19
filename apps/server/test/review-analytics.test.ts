import { beforeEach, describe, expect, test } from 'bun:test'

import { weekRange } from '@holtkeeper/ai-usage'
import type { ReviewAnalytics } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { type ReviewData, reviewMetrics } from '@holtkeeper/review'
import { builtinSettings } from '@holtkeeper/settings'
import type { NewAiUsageRecord, ReactionSignal, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'
import { daysBetween, latencyOf, sizeClass, spread } from '../src/review-analytics.ts'

const config = parseConfig({
  forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => ({}) as never } },
  teams: {
    shapes: { owns: ['work:shapes/*'] },
    colors: { owns: ['work:colors/*'] },
  },
})

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['*'] }],
    'shapes-ai': [{ scope: { teams: ['shapes'] }, actions: ['ai:read', 'analyses:read'] }],
    'shapes-reader': [{ scope: { teams: ['shapes'] }, actions: ['analyses:read'] }],
  },
})
const as = (group: string) => ({ 'x-forwarded-user': 'jane', 'x-forwarded-groups': group })

// A Wednesday; the 30-day period starts on 2026-10-12.
const now = new Date('2026-11-11T12:00:00.000Z')
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString()

const run = (path: string, overrides: Partial<NewAiUsageRecord> = {}): NewAiUsageRecord => ({
  at: daysAgo(1),
  repo: { forge: 'work', path },
  teams: [path.split('/')[0] ?? ''],
  taskKind: 'review',
  actor: 'system',
  provider: 'anthropic',
  model: 'model-a',
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 1,
  costSource: 'reported',
  durationMs: 1000,
  turns: 1,
  outcome: 'ok',
  ...overrides,
})

const review = (iid: number, overrides: Partial<ReviewData> = {}): ReviewData => ({
  mergeRequest: {
    id: iid,
    title: `Add widget ${iid}`,
    webUrl: `https://gitlab.test/acme/widgets/-/merge_requests/${iid}`,
    sourceBranch: 'feature/widget',
    targetBranch: 'main',
    author: 'alex',
  },
  head: 'b'.repeat(40),
  mode: 'full',
  verdict: 'needs-changes',
  summary: 'One problem.',
  comments: [
    {
      id: `f${iid}`,
      path: 'src/widget.ts',
      line: 3,
      severity: 'major',
      category: 'bug',
      title: 'Off by one',
      body: 'The loop skips the last item.',
      source: 'agent',
      suggestion: { replacement: 'for (const item of items)' },
      posted: true,
    },
  ],
  threads: [],
  skipped: [],
  stats: {
    files: 1,
    changedLines: 12,
    dropped: { belowSeverity: 0, overLimit: 0, duplicates: 0, invalid: 0, refuted: 2 },
  },
  approved: false,
  checks: [],
  ...overrides,
})

const signal = (overrides: Partial<ReactionSignal>): ReactionSignal => ({
  repo: 'work:shapes/circle',
  mergeRequest: 4,
  noteId: '1',
  category: 'bug',
  up: 0,
  down: 0,
  updatedAt: daysAgo(2),
  outcome: 'fixed',
  mergeRequestState: 'merged',
  ...overrides,
})

let store: Store
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  store = memoryStore()
  const vault = aesVault('v'.repeat(32))
  app = createApp({
    config,
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [],
    now: () => now,
  })

  for (const record of [
    run('shapes/circle', { mergeRequest: 4, phase: 'initial', costUsd: 3 }),
    run('shapes/circle', { mergeRequest: 4, phase: 'initial', taskKind: 'review-verify' }),
    run('shapes/circle', { mergeRequest: 4, phase: 'recheck', taskKind: 'triage', costUsd: 0.5 }),
    run('shapes/circle', { mergeRequest: 4, phase: 'reply', costUsd: 0.5 }),
    run('shapes/square', { mergeRequest: 9, phase: 'initial', costUsd: 2, at: daysAgo(3) }),
    run('shapes/square', { mergeRequest: 9, phase: 'update', costUsd: 1, at: daysAgo(3) }),
    run('shapes/square', { costUsd: 0.25, at: daysAgo(20) }),
    run('colors/red', { mergeRequest: 2, phase: 'initial', costUsd: 10 }),
    run('shapes/circle', { taskKind: 'chat', costUsd: 50 }),
    run('shapes/circle', { mergeRequest: 4, phase: 'initial', at: daysAgo(40), costUsd: 70 }),
  ])
    // oxlint-disable-next-line no-await-in-loop -- records keep their order
    await store.aiUsage.append(record)

  const add = (path: string, createdAt: string, data: ReviewData) =>
    store.analyses.add({
      repo: { forge: 'work', path },
      kind: 'review',
      ref: `!${data.mergeRequest.id}`,
      createdAt,
      data,
      metrics: reviewMetrics(data),
    })
  await add(
    'shapes/circle',
    daysAgo(1),
    review(4, {
      durationMs: 60_000,
      usage: { costUsd: 3, turns: 4 },
      size: { minutes: 40, level: 'ok', files: 3, lines: 120, groups: 2 },
    }),
  )
  await add('shapes/square', daysAgo(3), review(9))
  await add('shapes/square', daysAgo(2), review(9, { mode: 'incremental', comments: [] }))
  await add(
    'shapes/circle',
    daysAgo(1),
    review(4, {
      mode: 'reply',
      comments: [],
      threads: [{ discussionId: 'd1', action: 'resolved', reason: 'concede' }],
    }),
  )
  await add(
    'shapes/circle',
    daysAgo(1),
    review(4, {
      mode: 'reply',
      comments: [],
      threads: [
        { discussionId: 'd2', action: 'replied', reason: 'explain' },
        { discussionId: 'd3', action: 'resolved', reason: 'fixed' },
      ],
    }),
  )
  await add('colors/red', daysAgo(1), review(2))
  await add('shapes/square', daysAgo(2), review(12, { comments: [], verdict: 'looks-good' }))

  const finished = async (
    path: string,
    options: Record<string, unknown>,
    times: { created: string; runAfter: string; started: string; finished: string },
  ) => {
    const job = await store.jobs.enqueue({
      analyzer: 'review',
      repo: { forge: 'work', path },
      options,
      trigger: 'webhook',
      createdAt: times.created,
      runAfter: times.runAfter,
    })
    await store.jobs.claim('w1', times.started)
    await store.jobs.complete(job.id, { at: times.finished })
  }
  const at = (minutes: number) => new Date(Date.parse(daysAgo(1)) + minutes * 60_000).toISOString()
  await finished(
    'shapes/circle',
    { mergeRequest: 4 },
    {
      created: at(0),
      runAfter: at(2),
      started: at(3),
      finished: at(8),
    },
  )
  await finished(
    'shapes/circle',
    { mergeRequest: 4, replies: true },
    {
      created: at(20),
      runAfter: at(20),
      started: at(20),
      finished: at(21),
    },
  )
  await finished(
    'colors/red',
    { mergeRequest: 2 },
    {
      created: at(30),
      runAfter: at(30),
      started: at(30),
      finished: at(90),
    },
  )

  await store.learnings.putReactions(
    signal({ noteId: '1', up: 1, humanReplies: 2, severity: 'major' }),
  )
  await store.learnings.putReactions(
    signal({ noteId: '2', outcome: 'ignored', down: 1, severity: 'minor', category: 'style' }),
  )
  await store.learnings.putReactions(signal({ noteId: '3', outcome: 'resolved' }))
  await store.learnings.putReactions(signal({ noteId: '4', mergeRequestState: 'closed' }))
  await store.learnings.putReactions(signal({ noteId: '5', updatedAt: daysAgo(45) }))
  await store.learnings.putReactions(signal({ noteId: '6', repo: 'work:colors/red' }))
})

const analytics = async (query: string, group = 'admin') => {
  const response = await app.request(`/api/ai/reviews${query}`, { headers: as(group) })
  return { status: response.status, body: (await response.json()) as ReviewAnalytics }
}

describe('GET /api/ai/reviews', () => {
  test('spend per phase and merge request, runs, findings and outcomes of the period', async () => {
    const { status, body } = await analytics('?period=30d&teams=shapes')
    expect(status).toBe(200)
    expect(body.period).toMatchObject({ kind: '30d', to: now.toISOString() })
    expect(body.phases).toEqual([
      { phase: 'initial', costUsd: 6, runs: 3 },
      { phase: 'update', costUsd: 1, runs: 1 },
      { phase: 'recheck', costUsd: 0.5, runs: 1 },
      { phase: 'reply', costUsd: 0.5, runs: 1 },
      { phase: 'other', costUsd: 0.25, runs: 1 },
    ])
    expect(body.days).toHaveLength(31)
    expect(body.days.at(-2)).toEqual({
      day: '2026-11-10',
      phases: { initial: 4, recheck: 0.5, reply: 0.5 },
    })
    expect(body.mergeRequests).toMatchObject({
      count: 2,
      costUsd: 8,
      meanUsd: 4,
      medianUsd: 4,
      p90Usd: 5,
      untrackedUsd: 0.25,
    })
    expect(body.mergeRequests.top[0]).toEqual({
      repo: 'work:shapes/circle',
      mergeRequest: 4,
      title: 'Add widget 4',
      url: 'https://gitlab.test/acme/widgets/-/merge_requests/4',
      costUsd: 5,
      runs: 4,
      phases: { initial: 4, recheck: 0.5, reply: 0.5 },
    })
    expect(body.runs).toEqual({
      full: 3,
      incremental: 1,
      replies: { explain: 1, concede: 1, update: 0, fixed: 1, open: 0, unknown: 0 },
      skipped: 0,
    })
    expect(body.findings).toEqual({
      posted: 2,
      severities: { critical: 0, major: 2, minor: 0, info: 0 },
      suggestions: 2,
      refuted: 8,
    })
    expect(body.outcomes).toMatchObject({
      comments: 3,
      fixed: 1,
      resolved: 1,
      ignored: 1,
      up: 1,
      down: 1,
      discussed: 1,
    })
    expect(body.costPerFixedUsd).toBe(8.25)
    expect(body.partial).toBeUndefined()
  })

  test('trend, repositories, noise and speed of the period', async () => {
    const { body } = await analytics('?period=30d&teams=shapes')
    expect(body.trend).toHaveLength(31)
    expect(body.trend.find((day) => day.day === '2026-11-10')).toEqual({
      day: '2026-11-10',
      costUsd: 5,
      posted: 1,
      judged: 0,
      fixed: 0,
      resolved: 0,
      ignored: 0,
    })
    expect(body.trend.find((day) => day.day === '2026-11-09')).toMatchObject({
      posted: 0,
      judged: 3,
      fixed: 1,
      resolved: 1,
      ignored: 1,
    })
    expect(body.repos.map((row) => [row.repo, row.mergeRequests, row.costUsd, row.posted])).toEqual(
      [
        ['work:shapes/circle', 1, 5, 1],
        ['work:shapes/square', 2, 3.25, 1],
      ],
    )
    expect(body.repos[0]?.outcomes).toMatchObject({ comments: 3, fixed: 1, acceptance: 1 / 3 })
    expect(body.repos[0]?.costPerFixedUsd).toBe(5)
    expect(body.repos[1]?.costPerFixedUsd).toBeUndefined()
    expect(body.noise.bySeverity.map((row) => [row.key, row.comments])).toEqual([
      ['major', 1],
      ['minor', 1],
      ['unknown', 1],
    ])
    expect(body.noise.byCategory.map((row) => [row.key, row.comments])).toEqual([
      ['bug', 2],
      ['style', 1],
    ])
    expect(body.noise.perMergeRequest).toEqual({
      reviewed: 3,
      clean: 1,
      meanComments: 1,
      p90Comments: 1,
    })
    expect(body.speed.reviews).toEqual({
      count: 1,
      total: { medianMs: 480_000, p90Ms: 480_000 },
      wait: { medianMs: 60_000, p90Ms: 60_000 },
      run: { medianMs: 300_000, p90Ms: 300_000 },
    })
    expect(body.speed.replies?.count).toBe(1)
    expect(body.speed.bySize).toEqual([
      { size: 'small', reviews: 0, meanComments: 0 },
      { size: 'medium', reviews: 1, meanCostUsd: 3, meanDurationMs: 60_000, meanComments: 1 },
      { size: 'large', reviews: 0, meanComments: 0 },
      { size: 'huge', reviews: 0, meanComments: 0 },
    ])
  })

  test('limits spend to ai:read and records to analyses:read, and needs ai:read', async () => {
    const { body } = await analytics('?period=30d', 'shapes-ai')
    expect(body.mergeRequests.top.map((entry) => entry.repo)).not.toContain('work:colors/red')
    expect(body.runs.full).toBe(3)
    expect(body.outcomes.comments).toBe(3)
    expect((await analytics('?period=30d', 'shapes-reader')).status).toBe(403)
    expect((await analytics('?period=year')).status).toBe(400)
  })

  test('the week holds only this week, every phase present even without spend', async () => {
    const { body } = await analytics('?period=week&teams=shapes')
    expect(body.period.from).toBe(weekRange(now).from)
    expect(body.days.map((day) => day.day)).toEqual(
      daysBetween(body.period.from, now.toISOString()),
    )
    expect(body.days.at(-1)?.day).toBe('2026-11-11')
    expect(body.phases.map((entry) => entry.phase)).toEqual([
      'initial',
      'update',
      'recheck',
      'reply',
      'other',
    ])
    expect(body.phases.find((entry) => entry.phase === 'other')).toEqual({
      phase: 'other',
      costUsd: 0,
      runs: 0,
    })
  })
})

const job = (createdAt: string, runAfter: string, startedAt?: string, finishedAt?: string) =>
  ({ createdAt, runAfter, startedAt, finishedAt }) as Parameters<typeof latencyOf>[0][number]

describe('helpers', () => {
  test('daysBetween counts both ends in UTC', () => {
    expect(daysBetween('2026-10-30T22:00:00.000Z', '2026-11-01T01:00:00.000Z')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
    ])
  })

  test('sizeClass splits at 15 minutes, an hour and three hours', () => {
    expect([0, 14, 15, 59, 60, 179, 180].map(sizeClass)).toEqual([
      'small',
      'small',
      'medium',
      'medium',
      'large',
      'large',
      'huge',
    ])
  })

  test('latencyOf skips unfinished jobs and never counts the planned delay as waiting', () => {
    expect(latencyOf([job('2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')])).toBeUndefined()
    expect(
      latencyOf([
        job(
          '2026-11-01T00:00:00.000Z',
          '2026-11-01T00:05:00.000Z',
          '2026-11-01T00:04:00.000Z',
          '2026-11-01T00:06:00.000Z',
        ),
      ]),
    ).toEqual({
      count: 1,
      total: { medianMs: 360_000, p90Ms: 360_000 },
      wait: { medianMs: 0, p90Ms: 0 },
      run: { medianMs: 120_000, p90Ms: 120_000 },
    })
  })

  test('spread gives the median and the nearest-rank 90th percentile', () => {
    expect(spread([])).toBeUndefined()
    expect(spread([3])).toEqual({ median: 3, p90: 3 })
    expect(spread([4, 1, 3, 2])).toEqual({ median: 2.5, p90: 4 })
    expect(spread([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100])).toEqual({ median: 6, p90: 10 })
  })
})
