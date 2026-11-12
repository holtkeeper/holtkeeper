import { beforeEach, describe, expect, test } from 'bun:test'

import type { ReviewDetail, ReviewList } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import type { GuideBlock } from '@holtkeeper/guide'
import { type ReviewData, reviewMetrics } from '@holtkeeper/review'
import { builtinSettings } from '@holtkeeper/settings'
import type { AnalysisQuery, AnalysisStore, GuideScopeKey, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { builtinAnalyses } from '../src/analyses.ts'
import { createApp } from '../src/app.ts'
import { REVIEWS_SCAN, guideScopesOf } from '../src/reviews.ts'

const config = parseConfig({
  forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => ({}) as never } },
  groups: {
    shapes: { forge: 'work', include: ['shapes/*'] },
    colors: { forge: 'work', include: ['colors/*'] },
  },
})

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['*'] }],
    shapes: [{ scope: { groups: ['shapes'] }, actions: ['analyses:read'] }],
  },
})
const asAdmin = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'admin' }
const asShapes = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'shapes' }

const now = new Date('2026-11-10T12:00:00.000Z')
const daysAgo = (days: number, minutes = 0) =>
  new Date(now.getTime() - days * 86_400_000 - minutes * 60_000).toISOString()

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
      id: `f${iid}a`,
      path: 'src/widget.ts',
      line: 3,
      startLine: 2,
      severity: 'major',
      category: 'bug',
      title: 'Off by one',
      body: 'The loop skips the last item.',
      source: 'agent',
      suggestion: { replacement: 'for (const item of items)', original: 'for (i = 1; i < n; i++)' },
      posted: true,
    },
    {
      id: `f${iid}b`,
      path: 'src/widget.ts',
      line: 9,
      severity: 'minor',
      category: 'style',
      title: 'Name',
      body: 'Rename it.',
      source: 'agent',
      posted: false,
      error: 'line not in diff',
    },
  ],
  threads: [{ discussionId: 'd1', action: 'resolved', reason: 'fixed' }],
  skipped: [],
  stats: {
    files: 1,
    changedLines: 12,
    dropped: { belowSeverity: 0, overLimit: 0, duplicates: 0, invalid: 0 },
  },
  approved: false,
  checks: [],
  usage: { turns: 4, costUsd: 0.25, inputTokens: 9000, outputTokens: 800, model: 'model-a' },
  guideScopes: ['all', 'group:shapes'],
  durationMs: 64_000,
  ...overrides,
})

let store: Store
let app: ReturnType<typeof createApp>
let headReads: AnalysisQuery[]
let dataReads: string[]

const counting = (analyses: AnalysisStore): AnalysisStore => ({
  ...analyses,
  heads: async (query) => {
    headReads.push(query ?? {})
    return analyses.heads(query)
  },
  list: async (query) => {
    dataReads.push('list')
    return analyses.list(query)
  },
  latest: async (query) => {
    dataReads.push('latest')
    return analyses.latest(query)
  },
})

beforeEach(() => {
  store = memoryStore()
  headReads = []
  dataReads = []
  const vault = aesVault('v'.repeat(32))
  app = createApp({
    config,
    auth,
    store: { ...store, analyses: counting(store.analyses) },
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: builtinAnalyses,
    now: () => now,
  })
})

const add = (path: string, createdAt: string, data: ReviewData, metrics: object | null = null) =>
  store.analyses.add({
    repo: { forge: 'work', path },
    kind: 'review',
    ref: `!${data.mergeRequest.id}`,
    createdAt,
    data,
    metrics: metrics ?? reviewMetrics(data),
  })

const list = async (query = '', headers = asAdmin) => {
  const response = await app.request(`/api/reviews${query}`, { headers })
  expect(response.status).toBe(200)
  return (await response.json()) as ReviewList
}

describe('GET /api/reviews', () => {
  test('rows of the last 30 days from stored metrics, newest first, with totals', async () => {
    const newest = await add('shapes/circle', daysAgo(1), review(4))
    await add(
      'colors/red',
      daysAgo(2),
      review(5, { verdict: 'looks-good', comments: [], usage: { turns: 1, costUsd: 0.05 } }),
    )
    await add('shapes/circle', daysAgo(40), review(3))

    const result = await list()
    expect(result.reviews.map((row) => [row.repo.path, row.mergeRequest.iid])).toEqual([
      ['shapes/circle', 4],
      ['colors/red', 5],
    ])
    expect(result.reviews[0]).toEqual({
      analysisId: newest.id,
      repo: { forge: 'work', path: 'shapes/circle' },
      createdAt: daysAgo(1),
      mergeRequest: {
        iid: 4,
        title: 'Add widget 4',
        url: 'https://gitlab.test/acme/widgets/-/merge_requests/4',
        author: 'alex',
      },
      mode: 'full',
      verdict: 'needs-changes',
      findings: 1,
      severities: { info: 0, minor: 0, major: 1, critical: 0 },
      resolved: 1,
      model: 'model-a',
      durationMs: 64_000,
      guideScopes: ['all', 'group:shapes'],
      costUsd: 0.25,
    })
    expect(result.totals).toEqual({ reviews: 2, findings: 1, resolved: 2, costUsd: 0.3 })
    expect(result.window).toEqual({
      reviews: 2,
      verdicts: { 'looks-good': 1, 'needs-changes': 1, skipped: 0 },
      findings: 1,
      severities: { info: 0, minor: 0, major: 1, critical: 0 },
      resolved: 2,
      costUsd: 0.3,
    })
    expect(result.nextBefore).toBeUndefined()
    expect(dataReads).toEqual([])
    expect(headReads.every((query) => query.since === daysAgo(30))).toBe(true)

    const older = await list(`?since=${encodeURIComponent(daysAgo(60))}`)
    expect(older.reviews).toHaveLength(3)
  })

  test('filters by repository, group and verdict', async () => {
    await add('shapes/circle', daysAgo(1), review(4))
    await add('shapes/square', daysAgo(2), review(6, { verdict: 'looks-good' }))
    await add('colors/red', daysAgo(3), review(5, { verdict: 'looks-good' }))

    expect((await list('?repo=work:shapes/square')).reviews.map((r) => r.repo.path)).toEqual([
      'shapes/square',
    ])
    expect((await list('?group=colors')).reviews.map((r) => r.repo.path)).toEqual(['colors/red'])
    expect((await list('?verdict=looks-good')).reviews.map((r) => r.repo.path)).toEqual([
      'shapes/square',
      'colors/red',
    ])
    const bad = await app.request('/api/reviews?verdict=maybe', { headers: asAdmin })
    expect(bad.status).toBe(400)
    const badRepo = await app.request('/api/reviews?repo=shapes', { headers: asAdmin })
    expect(badRepo.status).toBe(400)
  })

  test('a narrow grant lists only the repositories it may read', async () => {
    await add('shapes/circle', daysAgo(1), review(4))
    await add('colors/red', daysAgo(2), review(5))

    expect((await list('', asShapes)).reviews.map((r) => r.repo.path)).toEqual(['shapes/circle'])
    const hidden = await app.request('/api/reviews?repo=work:colors/red', { headers: asShapes })
    expect(hidden.status).toBe(403)
  })

  test('pages by `before`; only the first page also sums the whole window', async () => {
    for (let day = 1; day <= 5; day++) await add('shapes/circle', daysAgo(day), review(day))

    const first = await list('?limit=2')
    expect(first.reviews.map((r) => r.mergeRequest.iid)).toEqual([1, 2])
    expect(first.nextBefore).toBe(daysAgo(2))
    expect(first.window?.reviews).toBe(5)
    expect(headReads.map((query) => query.limit)).toEqual([3, 200])

    headReads = []
    const second = await list(`?limit=2&before=${encodeURIComponent(first.nextBefore ?? '')}`)
    expect(second.reviews.map((r) => r.mergeRequest.iid)).toEqual([3, 4])
    expect(second.window).toBeUndefined()
    expect(headReads.map((query) => query.limit)).toEqual([3])
    const last = await list(`?limit=2&before=${encodeURIComponent(second.nextBefore ?? '')}`)
    expect(last.reviews.map((r) => r.mergeRequest.iid)).toEqual([5])
    expect(last.nextBefore).toBeUndefined()

    headReads = []
    await list('?limit=5000')
    expect(headReads.map((query) => query.limit)).toEqual([201, 200])
  })

  test('stops after a fixed number of heads when the caller may read few of them', async () => {
    await add('shapes/circle', daysAgo(20), review(1))
    for (let index = 0; index < REVIEWS_SCAN + 10; index++)
      // oxlint-disable-next-line no-await-in-loop -- records must keep their order
      await add('colors/red', daysAgo(1, index), review(100 + index), {})

    const result = await list('?limit=10', asShapes)
    expect(result.reviews).toEqual([])
    expect(result.nextBefore).toBe(daysAgo(1, REVIEWS_SCAN - 1))
    expect(result.window).toMatchObject({ reviews: 0, partial: true })
    expect(headReads.reduce((sum, query) => sum + (query.limit ?? 0), 0)).toBe(2 * REVIEWS_SCAN)

    const next = await list(
      `?limit=10&before=${encodeURIComponent(result.nextBefore ?? '')}`,
      asShapes,
    )
    expect(next.reviews.map((r) => r.mergeRequest.iid)).toEqual([1])
    expect(next.nextBefore).toBeUndefined()
  })

  test('records stored before the newer metrics fields still list', async () => {
    await add('shapes/circle', daysAgo(1), review(4), {
      mergeRequest: 4,
      verdict: 'looks-good',
      mode: 'full',
      comments: 0,
      severities: { info: 0, minor: 0, major: 0, critical: 0 },
      suggestions: 0,
      rejected: 0,
      resolved: 0,
      approved: false,
    })
    const [row] = (await list()).reviews
    expect(row?.mergeRequest).toEqual({ iid: 4, title: '!4', url: '' })
    expect(row?.guideScopes).toEqual([])
    expect(row?.model).toBeUndefined()
  })
})

describe('GET /api/reviews/:id', () => {
  test('one run with its findings, branches and usage', async () => {
    const record = await add('shapes/circle', daysAgo(1), review(4))
    const response = await app.request(`/api/reviews/${record.id}`, { headers: asShapes })
    expect(response.status).toBe(200)
    const detail = (await response.json()) as ReviewDetail
    expect(detail.review).toMatchObject({ analysisId: record.id, findings: 1, model: 'model-a' })
    expect(detail).toMatchObject({
      summary: 'One problem.',
      head: 'b'.repeat(40),
      sourceBranch: 'feature/widget',
      targetBranch: 'main',
      usage: { turns: 4, inputTokens: 9000, outputTokens: 800 },
    })
    expect(detail.findings.map((f) => [f.id, f.posted, f.error])).toEqual([
      ['f4a', true, undefined],
      ['f4b', false, 'line not in diff'],
    ])
    expect(detail.findings[0]).toMatchObject({
      startLine: 2,
      suggestion: { replacement: 'for (const item of items)' },
    })
  })

  test('404 for other kinds, unknown ids and repositories the caller may not read', async () => {
    const hidden = await add('colors/red', daysAgo(1), review(5))
    const other = await store.analyses.add({
      repo: { forge: 'work', path: 'shapes/circle' },
      kind: 'branches',
      createdAt: daysAgo(1),
      data: {},
    })
    for (const id of [hidden.id, other.id, 'missing']) {
      // oxlint-disable-next-line no-await-in-loop -- one request per case
      const response = await app.request(`/api/reviews/${id}`, { headers: asShapes })
      expect(response.status).toBe(404)
    }
    const admin = await app.request(`/api/reviews/${hidden.id}`, { headers: asAdmin })
    expect(admin.status).toBe(200)
  })
})

const block = (scope: GuideScopeKey | undefined, chars: number): GuideBlock => ({
  layer: 'repo',
  ...(scope ? { scope } : {}),
  title: 'x',
  source: 'x',
  text: '',
  chars,
  fullChars: chars,
  cut: false,
})

test('guide scopes are the filled ones, broad to narrow, each once', () => {
  expect(
    guideScopesOf({
      blocks: [
        block('repo:work:shapes/circle', 10),
        block('family:f1', 5),
        block('group:shapes', 3),
        block('all', 7),
        block('group:shapes', 2),
        block('group:empty', 0),
        block(undefined, 40),
      ],
    }),
  ).toEqual(['all', 'group:shapes', 'family:f1', 'repo:work:shapes/circle'])
})

const ingest = (data: ReviewData) =>
  app.request('/api/analyses', {
    method: 'POST',
    headers: { ...asAdmin, 'content-type': 'application/json' },
    body: JSON.stringify({
      repo: { forge: 'work', path: 'shapes/circle' },
      kind: 'review',
      ref: `!${data.mergeRequest.id}`,
      data,
    }),
  })

test('ingest stores a review only with http(s) links', async () => {
  const base = review(8)
  expect((await ingest(base)).status).toBe(201)
  const script = 'javascript:alert(1)'
  expect(
    (await ingest({ ...base, mergeRequest: { ...base.mergeRequest, webUrl: script } })).status,
  ).toBe(400)
  const [first, ...rest] = base.comments
  expect((await ingest({ ...base, comments: [{ ...first!, href: script }, ...rest] })).status).toBe(
    400,
  )
})
