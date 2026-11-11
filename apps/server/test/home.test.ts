import { beforeEach, describe, expect, test } from 'bun:test'

import type { AuditRunSummary, HomeView, ReleaseCard } from '@holtkeeper/api'
import { emptySeverities } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { AuditEvent, Job, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { z } from 'zod'

import { createApp } from '../src/app.ts'
import {
  type HomeSources,
  attentionItems,
  auditItems,
  failureItems,
  releaseItems,
  repoTiles,
  staleItems,
  summarizeChanges,
} from '../src/home.ts'

const NOW = '2026-10-30T12:00:00.000Z'
const now = new Date(NOW)
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString()

const groupsOf = (repo: string) =>
  repo.startsWith('work:shapes/') ? ['shapes'] : repo.startsWith('work:colors/') ? ['colors'] : []

const job = (patch: Partial<Job> & { path: string }): Job => {
  const { path, ...rest } = patch
  return {
    id: `job-${Math.random().toString(36).slice(2)}`,
    analyzer: 'widgets',
    repo: { forge: 'work', path },
    options: {},
    trigger: 'schedule',
    status: 'failed',
    attempts: 1,
    maxAttempts: 1,
    runAfter: hoursAgo(2),
    createdAt: hoursAgo(2),
    finishedAt: hoursAgo(1),
    attemptsHistory: [],
    ...rest,
  }
}

const summary = (
  path: string,
  severities: Partial<AuditRunSummary['severities']>,
  patch: Partial<AuditRunSummary> = {},
): AuditRunSummary => {
  const counts = { ...emptySeverities(), ...severities }
  return {
    id: `run-${path}`,
    repo: { forge: 'work', path },
    trigger: 'schedule',
    startedAt: hoursAgo(3),
    finishedAt: hoursAgo(3),
    severities: counts,
    active: Object.values(counts).reduce((a, b) => a + b, 0),
    ignored: 0,
    resolved: 0,
    expiredAllowlist: 0,
    languages: [],
    tools: [],
    changedFiles: 0,
    ...patch,
  }
}

const card = (path: string, patch: Partial<ReleaseCard>): ReleaseCard => ({
  repo: { forge: 'work', path },
  stage: 'idle',
  mode: 'merge-request',
  ahead: 0,
  aheadCapped: false,
  unreleased: 0,
  unreleasedCapped: false,
  tickets: [],
  pipelines: {},
  needsAction: false,
  ...patch,
})

const sources = (patch: Partial<HomeSources> = {}): HomeSources => ({
  now,
  groupsOf,
  analyzerLabel: (kind) => (kind === 'widgets' ? 'Widgets' : kind),
  failedJobs: [],
  blockedJobs: [],
  recentJobs: [],
  audits: [],
  releases: [],
  learnings: [],
  knowledge: [],
  analyses: [],
  ...patch,
})

const event = (action: string, at: string, repo?: string, actor = 'u1'): AuditEvent => ({
  id: `${action}-${at}`,
  seq: 1,
  prevHash: '',
  hash: '',
  at,
  actor: { id: actor, name: actor, provider: 'users' },
  via: 'ui',
  action,
  target: { type: action.split('.')[0]!, ...(repo && { repo }) },
  outcome: 'ok',
})

describe('Needs attention rules', () => {
  test('failures group by analyzer and signature across repositories, old ones drop out', () => {
    const items = failureItems(
      sources({
        failedJobs: [
          job({ path: 'shapes/circle', errorSignature: 'sig-a', error: 'boom at 1\nstack' }),
          job({ path: 'colors/red', errorSignature: 'sig-a', error: 'boom at 2' }),
          job({ path: 'shapes/square', errorSignature: 'sig-b', error: 'other' }),
          job({ path: 'shapes/square', errorSignature: 'sig-a', finishedAt: hoursAgo(30) }),
        ],
      }),
    )
    expect(items.map((item) => [item.title, item.severity, item.count])).toEqual([
      ['Widgets failed 2 times in 2 repositories', 'high', 2],
      ['Widgets failed 1 time', 'medium', 1],
    ])
    expect(items[0]?.detail).toBe('boom at 1')
    expect(items[0]?.repos).toEqual([
      { repo: 'work:shapes/circle', groups: ['shapes'] },
      { repo: 'work:colors/red', groups: ['colors'] },
    ])
    expect(items[0]?.href).toBe('/jobs?status=failed&analyzer=widgets&signature=sig-a')
    expect(items[1]?.href).toContain('repo=work%3Ashapes%2Fsquare')
  })

  test('critical and high vulnerabilities name the change since the audit before', () => {
    const items = auditItems(
      sources({
        audits: [
          {
            latest: summary('shapes/circle', { critical: 1, high: 2 }, { expiredAllowlist: 2 }),
            previous: summary('shapes/circle', { high: 1 }),
          },
          { latest: summary('colors/red', { medium: 4 }) },
        ],
      }),
    )
    expect(items.map((item) => [item.kind, item.severity, item.title, item.detail])).toEqual([
      [
        'vulnerabilities',
        'critical',
        '1 critical and 2 high vulnerabilities',
        'Up from 1 in the audit before',
      ],
      ['allowlist', 'medium', '2 allowlist entries expired', undefined],
    ])
    expect(items[0]?.href).toBe('/audits/run-shapes/circle')
  })

  test('releases waiting on a person become items, idle ones do not', () => {
    const items = releaseItems(
      sources({
        releases: [
          card('shapes/circle', {
            stage: 'proposed',
            needsAction: true,
            waitingSince: hoursAgo(5),
          }),
          card('shapes/square', {
            stage: 'released',
            needsAction: true,
            deploy: {
              tag: 'v1.2.0',
              environments: [{ name: 'prod', status: 'failed', attempts: [], confirm: false }],
            },
          }),
          card('colors/red', { stage: 'idle' }),
        ],
      }),
    )
    expect(items.map((item) => [item.title, item.severity, item.href])).toEqual([
      ['Release proposed, waiting for acceptance', 'medium', '/releases/work:shapes/circle'],
      ['Deploy of v1.2.0 to prod failed', 'high', '/releases/work:shapes/square'],
    ])
  })

  test('stale analyses are counted per repository', () => {
    const head = (path: string, kind: string, hours: number) => ({
      id: `${path}-${kind}`,
      repo: { forge: 'work', path },
      kind,
      createdAt: hoursAgo(hours),
    })
    const items = staleItems(
      sources({
        analyses: [
          head('shapes/circle', 'widgets', 24 * 20),
          head('shapes/circle', 'gadgets', 24 * 30),
          head('colors/red', 'widgets', 24),
        ],
      }),
    )
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      title: '2 analyses older than 14 days',
      detail: 'Widgets, gadgets',
      at: hoursAgo(24 * 30),
      href: '/repos/view?repo=work%3Ashapes%2Fcircle',
    })
  })

  test('items sort by severity, then newest first', () => {
    const items = attentionItems(
      sources({
        failedJobs: [job({ path: 'shapes/circle', errorSignature: 'a', finishedAt: hoursAgo(2) })],
        blockedJobs: [
          job({ path: 'shapes/circle', status: 'blocked', error: 'weekly budget reached' }),
        ],
        audits: [{ latest: summary('colors/red', { critical: 1 }) }],
        knowledge: [
          {
            id: 'k1',
            title: 'Use widgets',
            body: '',
            kind: 'convention',
            status: 'proposed',
            scope: { all: true },
            topics: [],
            source: 'agent',
            author: 'agent:x',
            createdAt: hoursAgo(4),
            updatedAt: hoursAgo(4),
            version: 1,
          } as never,
        ],
      }),
    )
    expect(items.map((item) => item.kind)).toEqual([
      'vulnerabilities',
      'budget-blocked',
      'job-failures',
      'knowledge',
    ])
    expect(items[3]).toMatchObject({ repos: [], title: '1 knowledge proposal waits for review' })
  })
})

describe('summarizeChanges', () => {
  test('sums high-signal successful events per area and repository, newest first', () => {
    const changes = summarizeChanges(
      [
        event('release.version', hoursAgo(1), 'work:shapes/circle', 'u2'),
        event('release.version', hoursAgo(5), 'work:shapes/circle', 'u1'),
        event('release.version', hoursAgo(3), 'work:colors/red'),
        event('setting.update', hoursAgo(2)),
        event('user.preferences', hoursAgo(1)),
        event('job.create', hoursAgo(1), 'work:shapes/circle'),
        { ...event('knowledge.update', hoursAgo(1)), outcome: 'denied' },
      ],
      groupsOf,
    )
    expect(changes).toEqual([
      {
        kind: 'release',
        text: '2 versions cut',
        repo: { repo: 'work:shapes/circle', groups: ['shapes'] },
        count: 2,
        actors: ['u2', 'u1'],
        firstAt: hoursAgo(5),
        lastAt: hoursAgo(1),
      },
      {
        kind: 'settings',
        text: '1 settings change',
        count: 1,
        actors: ['u1'],
        firstAt: hoursAgo(2),
        lastAt: hoursAgo(2),
      },
      {
        kind: 'release',
        text: '1 version cut',
        repo: { repo: 'work:colors/red', groups: ['colors'] },
        count: 1,
        actors: ['u1'],
        firstAt: hoursAgo(3),
        lastAt: hoursAgo(3),
      },
    ])
  })
})

describe('repoTiles', () => {
  test('one tile per repository with jobs, vulnerabilities, release and freshness ticks', () => {
    const tiles = repoTiles(
      sources({
        recentJobs: [
          job({ path: 'shapes/circle', status: 'succeeded' }),
          job({ path: 'shapes/circle', status: 'failed' }),
          job({ path: 'shapes', group: 'shapes', status: 'failed' }),
        ],
        audits: [{ latest: summary('shapes/circle', { high: 2 }) }],
        releases: [card('shapes/circle', { unreleased: 3 })],
        analyses: [
          {
            id: 'a',
            repo: { forge: 'work', path: 'shapes/circle' },
            kind: 'widgets',
            createdAt: hoursAgo(1),
          },
        ],
      }),
      ['work:shapes/square', 'work:shapes/circle', 'work:shapes/circle'],
    )
    expect(tiles.map((tile) => tile.repo)).toEqual(['work:shapes/circle', 'work:shapes/square'])
    expect(tiles[0]?.status.map((s) => [s.key, s.tone, s.label])).toEqual([
      ['jobs', 'ok', 'Widgets succeeded'],
      ['vulnerabilities', 'warning', '2 high'],
      ['release', 'info', '3 unreleased commits'],
      ['analyses', 'ok', 'Analyses fresh'],
    ])
    expect(tiles[1]?.status.map((s) => s.tone)).toEqual(['none', 'none', 'none', 'none'])
  })
})

describe('GET /api/home', () => {
  const config = parseConfig({
    forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => ({}) as never } },
    groups: {
      shapes: { forge: 'work', include: ['shapes/*', 'shapes/circle'] },
      colors: { forge: 'work', include: ['colors/*'] },
    },
  })
  const auth = headerAuth({
    roles: {
      shapes: [{ scope: { groups: ['shapes'] }, actions: ['analyses:read', 'audits:read'] }],
    },
  })
  const asShapes = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'shapes' }
  let store: Store
  let clock: Date

  const app = (provider = auth) => {
    const vault = aesVault('v'.repeat(32))
    return createApp({
      config,
      auth: provider,
      store,
      vault,
      credentials: createCredentialService({ credentials: store.credentials, vault }),
      settings: builtinSettings,
      analyses: [],
      analyzers: [
        { kind: 'widgets', scope: 'repo', options: z.object({}), analysis: { label: 'Widgets' } },
      ],
      now: () => clock,
    })
  }

  const failJob = async (path: string) => {
    const queued = await store.jobs.enqueue({
      analyzer: 'widgets',
      repo: { forge: 'work', path },
      trigger: 'schedule',
      maxAttempts: 1,
      createdAt: hoursAgo(2),
    })
    await store.jobs.claim('w1', hoursAgo(2))
    return store.jobs.fail(queued.id, { at: hoursAgo(1), error: 'widget exploded' })
  }

  const read = async (headers: Record<string, string>, server = app()) => {
    const response = await server.request('/api/home', { headers })
    expect(response.status).toBe(200)
    return (await response.json()) as HomeView
  }

  const usage = (taskKind: string, costUsd: number) =>
    store.aiUsage.append({
      at: hoursAgo(1),
      repo: { forge: 'work', path: 'shapes/circle' },
      groups: ['shapes'],
      taskKind,
      actor: 'system',
      provider: 'anthropic',
      model: 'model-main',
      inputTokens: 10,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd,
      costSource: 'computed',
      durationMs: 10,
      turns: 1,
      outcome: 'ok',
    })

  beforeEach(() => {
    store = memoryStore()
    clock = now
  })

  test('shows only what the caller may read and no spend without ai:read', async () => {
    await failJob('shapes/circle')
    await failJob('colors/red')
    const home = await read(asShapes)
    expect(home.attention.map((item) => [item.kind, item.repos.map((r) => r.repo)])).toEqual([
      ['job-failures', ['work:shapes/circle']],
    ])
    expect(home.spend).toBeUndefined()
    expect(home.repos.map((tile) => tile.repo)).toEqual(['work:shapes/circle'])
    expect(home.repos[0]?.status[0]).toEqual({
      key: 'jobs',
      tone: 'danger',
      label: 'Widgets failed',
    })
    expect(home.changesDays).toBe(7)
  })

  test('spend measures this week against the default budget, by feature', async () => {
    await usage('review', 3)
    await usage('chat', 1)
    await usage('review', 2)
    const home = await read({}, app(noAuth()))
    expect(home.spend).toMatchObject({
      budgetId: 'default',
      spentUsd: 6,
      weeklyUsd: 150,
      reserveUsd: 25,
      action: 'block',
      byFeature: [
        { feature: 'review', costUsd: 5, runs: 2 },
        { feature: 'chat', costUsd: 1, runs: 1 },
      ],
    })
  })

  test('answers stay cached per principal for half a minute', async () => {
    const server = app()
    expect((await read(asShapes, server)).attention).toEqual([])
    await failJob('shapes/circle')
    expect((await read(asShapes, server)).attention).toEqual([])
    clock = new Date(now.getTime() + 31_000)
    expect((await read(asShapes, server)).attention).toHaveLength(1)
  })
})
