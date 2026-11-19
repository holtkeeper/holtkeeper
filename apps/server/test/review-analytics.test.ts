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
import { daysBetween, spread } from '../src/review-analytics.ts'

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
  await add('shapes/circle', daysAgo(1), review(4))
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
      threads: [{ discussionId: 'd2', action: 'replied', reason: 'explain' }],
    }),
  )
  await add('colors/red', daysAgo(1), review(2))

  await store.learnings.putReactions(signal({ noteId: '1', up: 1, humanReplies: 2 }))
  await store.learnings.putReactions(signal({ noteId: '2', outcome: 'ignored', down: 1 }))
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
      full: 2,
      incremental: 1,
      replies: { explain: 1, concede: 1, update: 0, unknown: 0 },
      skipped: 0,
    })
    expect(body.findings).toEqual({
      posted: 2,
      severities: { critical: 0, major: 2, minor: 0, info: 0 },
      suggestions: 2,
      refuted: 6,
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

  test('limits spend to ai:read and records to analyses:read, and needs ai:read', async () => {
    const { body } = await analytics('?period=30d', 'shapes-ai')
    expect(body.mergeRequests.top.map((entry) => entry.repo)).not.toContain('work:colors/red')
    expect(body.runs.full).toBe(2)
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

describe('helpers', () => {
  test('daysBetween counts both ends in UTC', () => {
    expect(daysBetween('2026-10-30T22:00:00.000Z', '2026-11-01T01:00:00.000Z')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
    ])
  })

  test('spread gives the median and the nearest-rank 90th percentile', () => {
    expect(spread([])).toBeUndefined()
    expect(spread([3])).toEqual({ median: 3, p90: 3 })
    expect(spread([4, 1, 3, 2])).toEqual({ median: 2.5, p90: 4 })
    expect(spread([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100])).toEqual({ median: 6, p90: 10 })
  })
})
