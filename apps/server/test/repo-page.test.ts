import { beforeEach, describe, expect, test } from 'bun:test'

import type { RepoOverview, RepoReviewList } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import type { ReviewData } from '@holtkeeper/review'
import { builtinSettings } from '@holtkeeper/settings'
import type { StackData } from '@holtkeeper/stack'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { builtinAnalyses } from '../src/analyses.ts'
import { createApp } from '../src/app.ts'
import { noteHead } from '../src/freshness.ts'

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

const at = '2026-11-10T00:00:00.000Z'
const circle = { forge: 'work', path: 'shapes/circle' }

const stack = (): StackData => ({
  group: 'shapes',
  checkedAt: at,
  soonDays: 180,
  repos: [
    { path: 'shapes/circle', files: ['.nvmrc'] },
    { path: 'shapes/square', files: [] },
  ],
  components: [
    {
      id: 'node',
      name: 'Node.js',
      kind: 'runtime',
      latest: '26.1.0',
      cycles: [
        { cycle: '26', eol: '2029-04-30' },
        { cycle: '18', eol: '2025-04-30', lts: true },
      ],
      usages: [
        {
          repo: 'shapes/circle',
          file: '.nvmrc',
          via: 'version-file',
          declared: '18',
          version: '18',
        },
        {
          repo: 'shapes/square',
          file: '.nvmrc',
          via: 'version-file',
          declared: '26',
          version: '26',
        },
      ],
    },
  ],
  conventions: [
    { repo: 'shapes/circle', file: '.nvmrc', mode: 'exact', status: 'drifts', problems: [] },
    { repo: 'shapes/square', file: '.nvmrc', mode: 'exact', status: 'matches', problems: [] },
  ],
  notes: [],
})

const review = (iid: number, overrides: Partial<ReviewData> = {}): ReviewData => ({
  mergeRequest: {
    id: iid,
    title: `Add widget ${iid}`,
    webUrl: `https://gitlab.test/shapes/circle/-/merge_requests/${iid}`,
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
      severity: 'major',
      category: 'bug',
      title: 'Off by one',
      body: 'The loop skips the last item.',
      source: 'agent',
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
  usage: { turns: 4, costUsd: 0.25 },
  ...overrides,
})

let store: Store

const get = async (path: string, headers = asAdmin) => {
  const vault = aesVault('v'.repeat(32))
  const app = createApp({
    config,
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: builtinAnalyses,
    now: () => new Date(at),
  })
  const response = await app.request(path, { headers })
  return { status: response.status, body: await response.json() }
}

beforeEach(() => {
  store = memoryStore()
})

describe('repository overview', () => {
  test('newest record per kind without reviews, head, audit, dependencies and stack', async () => {
    await store.analyses.add({
      repo: circle,
      kind: 'coverage',
      createdAt: '2026-11-01T00:00:00.000Z',
      sha: 'a'.repeat(40),
      data: { tools: [], languages: [], summary: { lines: { covered: 1, total: 2 } }, files: [] },
    })
    await store.analyses.add({
      repo: circle,
      kind: 'review',
      ref: '!4',
      createdAt: '2026-11-02T00:00:00.000Z',
      data: review(4),
    })
    await store.analyses.add({
      repo: { forge: 'work', path: 'shapes' },
      kind: 'stack',
      createdAt: at,
      data: stack(),
    })
    if (!store.kv) throw new Error('memory store has kv')
    await noteHead(store.kv, circle, 'c'.repeat(40), new Date(at))

    const { status, body } = await get('/api/repos/overview?repo=work:shapes/circle')
    expect(status).toBe(200)
    const overview = body as RepoOverview
    expect(overview.groups).toEqual(['shapes'])
    expect(overview.head).toEqual({ sha: 'c'.repeat(40), at })
    expect(overview.analyses.map((a) => [a.kind, a.sha])).toEqual([['coverage', 'a'.repeat(40)]])
    expect(overview.dependencies).toBeUndefined()
    expect(overview.stack?.tools).toEqual([
      {
        id: 'node',
        name: 'Node.js',
        declared: '18',
        file: '.nvmrc',
        support: 'eol',
        eolDate: '2025-04-30',
      },
    ])
    expect(overview.stack?.conventions).toEqual({ matches: 0, drifts: 1, missing: 0, error: 0 })
  })

  test('needs analyses:read on the repository and a repo', async () => {
    expect((await get('/api/repos/overview?repo=work:colors/red', asShapes)).status).toBe(403)
    expect((await get('/api/repos/overview?repo=work:shapes/circle', asShapes)).status).toBe(200)
    expect((await get('/api/repos/overview')).status).toBe(400)
  })

  test('leaves the audit out without audits:read', async () => {
    await store.auditRuns.add({
      repo: circle,
      trigger: 'cli',
      startedAt: at,
      finishedAt: at,
      report: {
        scanner: 'osv-scanner',
        findings: [],
        ignored: [],
        expired: [],
        fixes: [],
        resolved: [],
        changedFiles: [],
      },
    })
    const admin = (await get('/api/repos/overview?repo=work:shapes/circle')).body as RepoOverview
    expect(admin.audit?.repo).toEqual(circle)
    const reader = (await get('/api/repos/overview?repo=work:shapes/circle', asShapes))
      .body as RepoOverview
    expect(reader.audit).toBeUndefined()
  })
})

describe('repository reviews', () => {
  test('newest runs with cost, posted comments and reactions on their own comments', async () => {
    await store.analyses.add({
      repo: circle,
      kind: 'review',
      ref: '!4',
      createdAt: '2026-11-02T00:00:00.000Z',
      data: review(4),
    })
    await store.analyses.add({
      repo: circle,
      kind: 'review',
      ref: '!5',
      createdAt: '2026-11-03T00:00:00.000Z',
      data: review(5, { verdict: 'looks-good', usage: { turns: 1 } }),
    })
    await store.analyses.add({
      repo: circle,
      kind: 'review',
      ref: '!6',
      createdAt: '2026-11-04T00:00:00.000Z',
      data: { broken: true },
    })
    const signal = {
      repo: 'work:shapes/circle',
      mergeRequest: 4,
      noteId: '1',
      category: 'bug',
      findingId: 'f4a',
      up: 2,
      down: 1,
      updatedAt: at,
    }
    await store.learnings.putReactions(signal)
    await store.learnings.putReactions({ ...signal, noteId: '2', findingId: 'f4b', up: 9 })
    await store.learnings.putReactions({
      ...signal,
      mergeRequest: 5,
      findingId: 'f5a',
      up: 1,
      down: 0,
    })

    const { status, body } = await get('/api/repos/reviews?repo=work:shapes/circle')
    expect(status).toBe(200)
    const list = body as RepoReviewList
    expect(
      list.reviews.map((r) => [
        r.mergeRequest.iid,
        r.verdict,
        r.posted,
        r.resolved,
        r.costUsd,
        r.reactions,
      ]),
    ).toEqual([
      [5, 'looks-good', 1, 1, undefined, { up: 1, down: 0 }],
      [4, 'needs-changes', 1, 1, 0.25, { up: 2, down: 1 }],
    ])
    expect(list.totals).toEqual({ costUsd: 0.25, posted: 2, up: 3, down: 1 })
  })

  test('needs analyses:read on the repository', async () => {
    expect((await get('/api/repos/reviews?repo=work:colors/red', asShapes)).status).toBe(403)
    expect(
      ((await get('/api/repos/reviews?repo=work:shapes/circle', asShapes)).body as RepoReviewList)
        .reviews,
    ).toEqual([])
  })
})
