import { beforeEach, describe, expect, test } from 'bun:test'

import type { RepoOverview } from '@holtkeeper/api'
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

const metricsRecord = (kind: string, metrics: Record<string, unknown>, data: unknown = {}) =>
  store.analyses.add({ repo: circle, kind, createdAt: '2026-11-09T00:00:00.000Z', data, metrics })

const overviewOf = async (headers = asAdmin) => {
  const { status, body } = await get('/api/repos/overview?repo=work:shapes/circle', headers)
  expect(status).toBe(200)
  return body as RepoOverview
}

describe('repository hub overview', () => {
  test('health strip and cards follow the caller’s permissions', async () => {
    await metricsRecord('audit', {
      findings: 3,
      severities: { critical: 0, high: 1, medium: 2, low: 0, unknown: 0 },
      ignored: 1,
      expired: 0,
      resolved: 0,
    })
    await metricsRecord('coverage', { percent: 55, target: 60, files: 3, untested: 1 })
    await store.analyses.add({
      repo: { forge: 'work', path: 'shapes' },
      kind: 'stack',
      createdAt: at,
      data: stack(),
    })

    const admin = await overviewOf()
    expect(admin.cards.map((card) => card.key)).toEqual([
      'security',
      'libraries',
      'licenses',
      'stack',
      'public-api',
      'coverage',
      'bundles',
      'assets',
      'ci',
      'branches',
    ])
    expect(admin.cells.security?.tone).toBe('bad')
    expect(admin.health).toBe('failing')
    const card = (key: string) => admin.cards.find((entry) => entry.key === key)
    expect(card('security')).toMatchObject({
      section: 'supply',
      tone: 'bad',
      status: '1 high',
      value: '3',
      unit: 'active findings',
      lines: ['1 high or critical · 2 medium · 0 low', 'Audited 1 d ago · 1 allowlisted'],
    })
    expect(card('security')?.segments).toEqual([
      { tone: 'bad', share: 0.333 },
      { tone: 'warn', share: 0.667 },
    ])
    expect(card('coverage')).toMatchObject({
      section: 'quality',
      tone: 'bad',
      status: 'Below target',
      value: '55.0%',
      lines: ['target 60%', '1 file without tests'],
    })
    expect(card('stack')).toMatchObject({ tone: 'bad', status: '1 ended', value: 'node 18' })
    expect(card('public-api')).toMatchObject({ tone: 'none', status: 'Not analysed', value: '—' })
    expect(admin.toolchain).toEqual([{ name: 'node', version: '18' }])

    const reader = await overviewOf(asShapes)
    expect(reader.cards.map((entry) => entry.key)).not.toContain('security')
    expect(reader.cells.security).toBeUndefined()
    expect(reader.cells.release).toBeUndefined()
    expect(reader.cells.coverage?.tone).toBe('bad')
    expect(reader.knowledge).toBeUndefined()
    expect(reader.release).toBeUndefined()
  })

  test('the coverage card judges by the repository’s coverage target', async () => {
    await metricsRecord('coverage', { percent: 55, target: 60, files: 3, untested: 0 })
    await store.settings.put({
      id: 'cov',
      key: 'analyzers.coverage',
      scope: { repos: ['work:shapes/circle'] },
      value: { target: 50 },
      secret: false,
      updatedAt: at,
    })
    const coverage = (await overviewOf()).cards.find((card) => card.key === 'coverage')
    expect(coverage).toMatchObject({ tone: 'ok', status: 'On target', lines: ['target 50%'] })
  })

  test('reviews of 30 days, this week’s work, knowledge, default branch and access', async () => {
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
      ref: '!3',
      createdAt: '2026-09-01T00:00:00.000Z',
      data: review(3),
    })
    await store.analyses.add({
      repo: circle,
      kind: 'branches',
      createdAt: at,
      data: { defaultBranch: 'main' },
    })

    const job = (createdAt: string, runAfter = createdAt) =>
      store.jobs.enqueue({
        analyzer: 'coverage',
        repo: circle,
        trigger: 'manual',
        maxAttempts: 1,
        createdAt,
        runAfter,
      })
    const failing = await job('2026-11-09T08:00:00.000Z')
    await job('2026-11-09T09:00:00.000Z')
    await job('2026-11-08T09:00:00.000Z', '2026-12-01T00:00:00.000Z')
    const claimed = await store.jobs.claim('worker', at)
    expect(claimed?.id).toBe(failing.id)
    await store.jobs.fail(failing.id, { at, error: 'boom' })
    const usage = (cost: number, jobId?: string) =>
      store.aiUsage.append({
        at,
        repo: circle,
        groups: ['shapes'],
        taskKind: 'review',
        ...(jobId ? { jobId } : {}),
        actor: 'system',
        provider: 'anthropic',
        model: 'claude',
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: cost,
        costSource: 'reported',
        durationMs: 1,
        turns: 1,
        outcome: 'ok',
      })
    await usage(0.4, failing.id)
    await usage(1)
    await store.tasks.put({
      id: 't1',
      groupId: 'g1',
      kind: 'fix',
      title: 'Fix widget',
      prompt: 'Fix it.',
      repo: 'work:shapes/circle',
      requester: 'jane',
      source: { type: 'api' },
      status: 'proposed',
      createdAt: at,
      updatedAt: at,
    })

    const section = (scope: 'repo:work:shapes/circle' | 'group:shapes' | 'group:colors') =>
      store.guides.put({
        scope,
        section: 'general',
        rules: 'Use widgets.',
        steering: '',
        learnings: [],
      })
    await section('repo:work:shapes/circle')
    await section('group:shapes')
    await store.guides.put({
      scope: 'repo:work:shapes/circle',
      section: 'testing',
      rules: '',
      steering: '',
      learnings: [],
    })
    await store.knowledge.put({
      id: 'n1',
      title: 'Widgets',
      body: 'Body.',
      kind: 'decision',
      scope: { repos: ['work:shapes/circle'] },
      topics: [],
      appliesTo: ['*'],
      status: 'accepted',
      evidence: [],
      source: 'human',
      author: 'header:jane',
      createdAt: at,
      updatedAt: at,
    })
    await store.learnings.put({
      id: 'l1',
      repo: 'work:shapes/circle',
      rule: 'Name widgets clearly.',
      key: 'name widgets clearly',
      section: 'general',
      suggestedScope: 'repo',
      status: 'proposed',
      sources: [],
      model: 'claude',
      costUsd: 0,
      createdAt: at,
      updatedAt: at,
    })
    await store.settings.put({
      id: 'ro',
      key: 'repo.freeze',
      scope: { repos: ['work:shapes/circle'] },
      value: { reason: 'Vendored widget kit', until: '2099-01-01T00:00:00+00:00' },
      secret: false,
      updatedAt: at,
    })

    const overview = await overviewOf()
    expect(overview.reviews30d).toEqual({
      reviews: 1,
      posted: 1,
      resolved: 1,
      up: 0,
      down: 0,
      costUsd: 0.25,
    })
    expect(overview.work).toEqual({ runs: 2, failed: 1, awaitingApproval: 1, costUsd: 0.4 })
    expect(overview.knowledge).toEqual({
      sections: 1,
      notes: 1,
      proposed: 1,
      inherits: ['group shapes'],
    })
    expect(overview.defaultBranch).toBe('main')
    expect(overview.access).toEqual({
      readOnly: true,
      reason: 'Vendored widget kit',
      until: '2099-01-01T00:00:00.000Z',
      writeTasks: false,
    })
    expect(overview.release).toBeUndefined()
    expect(JSON.stringify(overview)).not.toContain('title')
  })
})

test('the release card comes from the stored Releases snapshot and needs releases:read', async () => {
  await store.kv?.set('release:board:index', { repos: [circle], readAt: at })
  await store.kv?.set('release:board:row:work:shapes/circle', {
    readAt: at,
    head: 'h'.repeat(40),
    row: {
      repo: circle,
      stage: 'released',
      mode: 'trunk',
      latest: { tag: 'v1.2.0', version: '1.2.0', sha: 'a'.repeat(40), date: at },
      ahead: 0,
      aheadCapped: false,
      unreleased: 3,
      unreleasedCapped: false,
      tickets: [],
      pipelines: {},
      blockers: [],
      acceptanceRequired: false,
      reasons: [],
      leftOut: 0,
      tasks: 0,
      environments: [],
      deploy: {
        tag: 'v1.2.0',
        environments: [
          {
            name: 'production',
            status: 'success',
            confirm: false,
            attempts: [
              {
                jobId: 1,
                status: 'success',
                webUrl: 'https://gitlab.test/j/1',
                finishedAt: '2026-11-09T10:00:00.000Z',
              },
            ],
          },
          { name: 'staging', status: 'failed', confirm: false, attempts: [] },
        ],
      },
    },
  })
  const admin = await overviewOf()
  expect(admin.release).toEqual({
    stage: 'released',
    latest: { tag: 'v1.2.0', version: '1.2.0', sha: 'a'.repeat(40), date: at },
    unreleased: 3,
    unreleasedCapped: false,
    deployed: { environment: 'production', at: '2026-11-09T10:00:00.000Z' },
  })
  expect(admin.cells.release?.value).toBe('Deploy failed')
  expect((await overviewOf(asShapes)).release).toBeUndefined()
})
