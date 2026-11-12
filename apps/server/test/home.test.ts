import { beforeEach, describe, expect, test } from 'bun:test'

import { auditAnalysis } from '@holtkeeper/analyzers'
import type { AuditRunSummary, HomeView, ReleaseCard } from '@holtkeeper/api'
import { emptySeverities } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { AuditEvent, Job, LearningCandidate, SettingEntry, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { z } from 'zod'

import { createApp } from '../src/app.ts'
import {
  type HomeSources,
  allowlistItems,
  attentionItems,
  auditItems,
  failureItems,
  notAnalysedItems,
  releaseItems,
  staleItems,
  summarizeChanges,
} from '../src/home.ts'
import { addSnooze } from '../src/snoozes.ts'

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
  blockers: [],
  acceptanceRequired: false,
  reasons: [],
  leftOut: 0,
  tasks: 0,
  environments: [],
  needsAction: false,
  can: { accept: false, run: false },
  ...patch,
})

const sources = (patch: Partial<HomeSources> = {}): HomeSources => ({
  now,
  groupsOf,
  analyzerLabel: (kind) => (kind === 'widgets' ? 'Widgets' : kind),
  failedJobs: [],
  blockedJobs: [],
  audits: [],
  releases: [],
  learnings: [],
  knowledge: [],
  analyses: [],
  allowlists: [],
  repos: [],
  ...patch,
})

const learning = (id: string, repo: string, createdAt: string): LearningCandidate => ({
  id,
  repo,
  rule: 'Prefer widgets over gadgets',
  key: id,
  section: 'general',
  suggestedScope: 'repo',
  status: 'proposed',
  sources: [],
  model: 'model-fast',
  costUsd: 0,
  createdAt,
  updatedAt: createdAt,
})

const allowlist = (id: string, value: unknown, scope: SettingEntry['scope'] = { all: true }) => ({
  id,
  key: 'audit.allowlist',
  scope,
  value,
  secret: false,
  updatedAt: hoursAgo(100),
})

const event = (
  action: string,
  at: string,
  repo?: string,
  actor = 'u1',
  details?: Record<string, unknown>,
): AuditEvent => ({
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
  ...(details && { details }),
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
    expect(items[0]?.href).toBe('/ops/runs?status=failed&analyzer=widgets&signature=sig-a')
    expect(items[1]?.href).toContain('repo=work%3Ashapes%2Fsquare')
    expect(items.map((item) => item.id)).toEqual([
      'job-failures:widgets:sig-a',
      'job-failures:widgets:sig-b',
    ])
    expect(items[0]?.action).toEqual({
      type: 'open',
      label: 'View runs',
      href: '/ops/runs?status=failed&analyzer=widgets&signature=sig-a',
    })
  })

  test('Retry is offered only when every repository of the item may be run again', () => {
    const circle = job({ path: 'shapes/circle', errorSignature: 'sig-a' })
    const red = job({ path: 'colors/red', errorSignature: 'sig-a', finishedAt: hoursAgo(1.5) })
    const failedJobs = [circle, red]
    const everywhere = failureItems(sources({ failedJobs, canRetry: () => true }))
    expect(everywhere[0]?.action).toEqual({
      type: 'retry',
      label: 'Retry',
      analyzer: 'widgets',
    })
    const shapesOnly = failureItems(
      sources({ failedJobs, canRetry: (repo) => repo.startsWith('work:shapes/') }),
    )
    expect(shapesOnly[0]?.action.type).toBe('open')
    const group = failureItems(
      sources({
        failedJobs: [job({ path: 'shapes', group: 'shapes', errorSignature: 'sig-c' })],
        canRetry: () => true,
      }),
    )
    expect(group[0]?.action.type).toBe('open')
  })

  test('a subgroup analysis failure belongs to the subgroup and its parent', () => {
    const items = failureItems(
      sources({
        failedJobs: [job({ path: 'shapes.round', group: 'shapes.round', errorSignature: 'sig-d' })],
      }),
    )
    expect(items[0]?.repos).toEqual([
      { repo: 'work:shapes.round', groups: ['shapes.round', 'shapes'] },
    ])
  })

  test('failures without a signature group per analyzer and repository', () => {
    const items = failureItems(
      sources({
        failedJobs: [
          job({ path: 'shapes/circle', error: 'boom' }),
          job({ path: 'shapes/circle', error: 'bang' }),
          job({ path: 'colors/red', error: 'boom' }),
        ],
      }),
    )
    expect(items.map((item) => [item.id, item.count])).toEqual([
      ['job-failures:widgets:work:shapes/circle', 2],
      ['job-failures:widgets:work:colors/red', 1],
    ])
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
    ])
    expect(items[0]?.href).toBe('/supply/security/runs/run-shapes%2Fcircle')
    expect(items[0]?.action).toEqual({
      type: 'open',
      label: 'Open audit',
      href: '/supply/security/runs/run-shapes%2Fcircle',
    })
  })

  test('allowlist entries that expired or expire within 7 days open their Inbox item', () => {
    const items = allowlistItems(
      sources({
        allowlists: [
          allowlist(
            's1',
            [
              { id: 'GHSA-old', reason: 'No fix yet\nupstream', expires: '2026-10-29' },
              { id: 'GHSA-soon', package: 'some-lib', reason: 'Dev only', expires: '2026-11-03' },
              { id: 'GHSA-later', reason: 'Later', expires: '2026-12-31' },
              { id: 'GHSA-never', reason: 'Forever' },
            ],
            { repos: ['work:shapes/circle', 'work:colors/*'] },
          ),
          allowlist('s2', 'not a list'),
        ],
      }),
    )
    expect(items.map((item) => [item.id, item.kind, item.severity, item.title])).toEqual([
      ['allowlist:s1:GHSA-old', 'allowlist', 'medium', 'Allowlist entry for GHSA-old expired'],
      [
        'allowlist:s1:GHSA-soon:some-lib',
        'allowlist-expiring',
        'low',
        'Allowlist entry for GHSA-soon expires on 2026-11-03',
      ],
    ])
    expect(items[0]).toMatchObject({
      detail: 'No fix yet',
      repos: [{ repo: 'work:shapes/circle', groups: ['shapes'] }],
      at: '2026-10-23T00:00:00.000Z',
      href: '/inbox?item=allowlist%3As1%3AGHSA-old&kind=allowlist',
    })
    expect(items[1]?.action).toEqual({
      type: 'renew',
      label: 'Renew',
      href: '/inbox?item=allowlist%3As1%3AGHSA-soon%3Asome-lib&kind=allowlist',
    })
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
      [
        'Release proposed, waiting for acceptance',
        'medium',
        '/releases/timeline?repo=work%3Ashapes%2Fcircle',
      ],
      ['Deploy of v1.2.0 to prod failed', 'high', '/releases/timeline?repo=work%3Ashapes%2Fsquare'],
    ])
    expect(items[0]?.action).toEqual({
      type: 'open',
      label: 'Open release',
      href: '/releases/timeline?repo=work%3Ashapes%2Fcircle',
    })
  })

  test('a release the caller may decide opens its Inbox item for review', () => {
    const [item] = releaseItems(
      sources({
        releases: [
          card('shapes/circle', {
            stage: 'proposed',
            needsAction: true,
            head: 'abc123',
            can: { accept: true, run: true },
          }),
        ],
      }),
    )
    const href = '/inbox?item=release%3Awork%3Ashapes%2Fcircle&kind=release'
    expect(item?.href).toBe(href)
    expect(item?.action).toEqual({ type: 'review', label: 'Review', href })
  })

  test('learnings open the oldest proposal of the repository in the Inbox', () => {
    const items = attentionItems(
      sources({
        learnings: [
          learning('l2', 'work:shapes/circle', hoursAgo(2)),
          learning('l1', 'work:shapes/circle', hoursAgo(5)),
        ],
      }),
    )
    const href = '/inbox?item=learning%3Al1&kind=learning'
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'learnings:work:shapes/circle',
      title: '2 learned rules wait for review',
      at: hoursAgo(2),
      href,
      action: { type: 'review', label: 'Review', href },
    })
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
      href: '/repos/work/shapes/circle',
      action: {
        type: 'open',
        label: 'Open repository',
        href: '/repos/work/shapes/circle',
      },
    })
  })

  test('repositories without any record are not analysed, unless the caller cannot read analyses', () => {
    const base = {
      repos: ['work:shapes/square', 'work:shapes/circle', 'work:colors/red', 'work:colors/blue'],
      analyses: [
        {
          id: 'a',
          repo: { forge: 'work', path: 'shapes/circle' },
          kind: 'widgets',
          createdAt: NOW,
        },
      ],
      audits: [{ latest: summary('colors/red', {}) }],
    }
    expect(notAnalysedItems(sources(base)).map((item) => [item.id, item.title])).toEqual([
      ['not-analysed:work:colors/blue', 'Not analysed yet'],
      ['not-analysed:work:shapes/square', 'Not analysed yet'],
    ])
    const [square] = notAnalysedItems(
      sources({
        ...base,
        access: (repo) => (action) => action !== 'analyses:read' || repo.groups.includes('shapes'),
      }),
    )
    expect(square).toMatchObject({
      kind: 'not-analysed',
      severity: 'low',
      repos: [{ repo: 'work:shapes/square', groups: ['shapes'] }],
      href: '/repos/work/shapes/square',
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
        repos: ['work:colors/teal'],
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
      'not-analysed',
    ])
    expect(items[1]?.href).toBe('/ops/runs?status=blocked')
    expect(items[3]).toMatchObject({
      repos: [],
      title: '1 knowledge proposal waits for review',
      href: '/inbox?item=note%3Ak1&kind=note',
      action: { type: 'review', href: '/inbox?item=note%3Ak1&kind=note' },
    })
  })
})

describe('summarizeChanges', () => {
  test('one sentence per successful high-signal event, newest first, with a link', () => {
    const changes = summarizeChanges(
      [
        event('release.versioned', hoursAgo(1), 'work:shapes/circle', 'u2', { version: '1.4.0' }),
        event('release.versioned', hoursAgo(5), 'work:shapes/circle', 'u1'),
        event('setting.update', hoursAgo(2)),
        event('user.preferences', hoursAgo(1)),
        event('user.login', hoursAgo(1)),
        event('job.create', hoursAgo(1), 'work:shapes/circle'),
        { ...event('knowledge.update', hoursAgo(1)), outcome: 'denied' },
      ],
      groupsOf,
    )
    expect(changes).toEqual([
      {
        id: `release.versioned-${hoursAgo(1)}`,
        kind: 'release',
        text: 'Cut version 1.4.0 of shapes/circle',
        href: '/releases/timeline?repo=work%3Ashapes%2Fcircle',
        at: hoursAgo(1),
        actor: 'u2',
        repo: { repo: 'work:shapes/circle', groups: ['shapes'] },
      },
      {
        id: `setting.update-${hoursAgo(2)}`,
        kind: 'settings',
        text: 'Changed a setting',
        href: '/settings/audit',
        at: hoursAgo(2),
        actor: 'u1',
      },
      {
        id: `release.versioned-${hoursAgo(5)}`,
        kind: 'release',
        text: 'Cut a version of shapes/circle',
        href: '/releases/timeline?repo=work%3Ashapes%2Fcircle',
        at: hoursAgo(5),
        actor: 'u1',
        repo: { repo: 'work:shapes/circle', groups: ['shapes'] },
      },
    ])
  })

  test('release steps run from the panel are changes', () => {
    const changes = summarizeChanges(
      [
        event('release.accepted', hoursAgo(1), 'work:shapes/circle', 'u1'),
        event('release.proposed', hoursAgo(2), 'work:shapes/circle', 'u1'),
        event('release.versioned', hoursAgo(3), 'work:shapes/circle', 'u1', { version: '2.0.0' }),
      ],
      groupsOf,
    )
    expect(changes.map((change) => change.text)).toEqual([
      'Accepted the release of shapes/circle',
      'Proposed a release of shapes/circle',
      'Cut version 2.0.0 of shapes/circle',
    ])
  })

  test('Guide rejections, release dismissals and allowlist renewals are changes', () => {
    const changes = summarizeChanges(
      [
        event('guide.reject', hoursAgo(1), 'work:shapes/circle'),
        event('release.dismiss', hoursAgo(2), 'work:colors/red', 'u1', { sha: 'abc123' }),
        event('allowlist.renew', hoursAgo(3), undefined, 'u1', {
          key: 'audit.allowlist',
          advisory: 'GHSA-1234',
        }),
      ],
      groupsOf,
    )
    expect(changes.map((change) => [change.kind, change.text, change.href])).toEqual([
      [
        'guide',
        'Rejected generated Guide text for shapes/circle',
        '/knowledge/guide?space=repo%3Awork%3Ashapes%2Fcircle',
      ],
      [
        'release',
        'Dismissed the waiting release of colors/red',
        '/releases/timeline?repo=work%3Acolors%2Fred',
      ],
      ['settings', 'Renewed the allowlist entry for GHSA-1234', '/supply/security'],
    ])
  })

  test('each accepted learning is a change; the batch request event is not', () => {
    const changes = summarizeChanges(
      [
        event('learning.accept', hoursAgo(1), 'work:shapes/circle'),
        event('learning.accept', hoursAgo(2), 'work:colors/red'),
        event('learnings.accept', hoursAgo(1)),
        {
          ...event('knowledge.update', hoursAgo(3)),
          target: { type: 'knowledge', id: 'n-1' },
        },
        {
          ...event('knowledge.delete', hoursAgo(4)),
          target: { type: 'knowledge', id: 'n-2' },
        },
      ],
      groupsOf,
    )
    expect(changes.map((change) => [change.text, change.href])).toEqual([
      [
        'Accepted a learned rule for shapes/circle',
        '/knowledge/learnings?space=repo%3Awork%3Ashapes%2Fcircle',
      ],
      [
        'Accepted a learned rule for colors/red',
        '/knowledge/learnings?space=repo%3Awork%3Acolors%2Fred',
      ],
      ['Edited a knowledge note', '/knowledge/notes?note=n-1'],
      ['Deleted a knowledge note', '/knowledge/notes'],
    ])
  })

  test('a rejected agent task is a change; other task events are not', () => {
    const changes = summarizeChanges(
      [
        {
          ...event('task.reject', hoursAgo(1), 'work:shapes/circle'),
          target: { type: 'task-group', id: 'g1a2b3c4', repo: 'work:shapes/circle' },
        },
        event('task.cancel', hoursAgo(2), 'work:shapes/circle'),
        event('task.approve', hoursAgo(3), 'work:shapes/circle'),
      ],
      groupsOf,
    )
    expect(changes.map((change) => [change.kind, change.text, change.href])).toEqual([
      ['task', 'Rejected a proposed agent task', '/ops/tasks?group=g1a2b3c4'],
    ])
  })

  test('sentences take only whitelisted short tokens from details', () => {
    const [deploy, deleted] = summarizeChanges(
      [
        event('release.deploy-started', hoursAgo(1), 'work:shapes/circle', 'u1', {
          tag: 'v1.2.0',
          environment: 'prod',
          detail: 'free text from a person',
        }),
        event('setting.delete', hoursAgo(2), undefined, 'u1', { key: 'Robert"); drop' }),
      ],
      groupsOf,
    )
    expect(deploy?.text).toBe('Started deploying v1.2.0 of shapes/circle to prod')
    expect(deleted?.text).toBe('Removed a setting')
  })

  test('keeps the newest events up to the limit', () => {
    const events = Array.from({ length: 5 }, (_, index) =>
      event('repo.discover', hoursAgo(index + 1), `work:shapes/s${index}`, 'system'),
    )
    const changes = summarizeChanges(events, groupsOf, 2)
    expect(changes.map((change) => [change.text, change.href])).toEqual([
      ['Found the new repository shapes/s0', '/repos/work/shapes/s0'],
      ['Found the new repository shapes/s1', '/repos/work/shapes/s1'],
    ])
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
      runners: [
        {
          scope: { groups: ['shapes'] },
          actions: ['analyses:read', 'audits:read', 'analyses:run'],
        },
      ],
    },
  })
  const asShapes = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'shapes' }
  const asRunner = { 'x-forwarded-user': 'joe', 'x-forwarded-groups': 'runners' }
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
      analyses: [auditAnalysis],
      analyzers: [
        { kind: 'widgets', scope: 'repo', options: z.object({}), analysis: { label: 'Widgets' } },
        { kind: 'audit', scope: 'repo', options: z.object({}), analysis: { label: 'Audit' } },
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

  const usage = (taskKind: string, costUsd: number, at = hoursAgo(1)) =>
    store.aiUsage.append({
      at,
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
      ['not-analysed', ['work:shapes/circle']],
    ])
    expect(home.spend).toBeUndefined()
    expect(home.changesDays).toBe(7)
    expect('repos' in home).toBe(false)
  })

  test('Retry needs analyses:run on the repository', async () => {
    await failJob('shapes/circle')
    const [narrow] = (await read(asShapes)).attention
    expect(narrow?.action.type).toBe('open')
    const [runner] = (await read(asRunner)).attention
    expect(runner?.action).toMatchObject({ type: 'retry', label: 'Retry', analyzer: 'widgets' })
  })

  test('allowlist entries need settings:read and settings:write on their scope', async () => {
    await store.settings.put(
      allowlist('s1', [{ id: 'GHSA-1', reason: 'No fix yet', expires: '2026-11-02' }], {
        all: true,
      }),
    )
    expect((await read(asShapes)).attention).toEqual([])
    const home = await read({}, app(noAuth()))
    expect(home.attention.find((item) => item.kind === 'allowlist-expiring')?.href).toBe(
      '/inbox?item=allowlist%3As1%3AGHSA-1&kind=allowlist',
    )
  })

  test('What changed lists one event per row with actors in people', async () => {
    await store.audit.append({
      at: hoursAgo(1),
      actor: { id: 'header:jane', name: 'jane', provider: 'header' },
      via: 'ui',
      action: 'release.dismiss',
      target: { type: 'release', repo: 'work:shapes/circle' },
      outcome: 'ok',
      details: { sha: 'abc123' },
    })
    const home = await read({}, app(noAuth()))
    expect(home.changes).toMatchObject([
      {
        kind: 'release',
        text: 'Dismissed the waiting release of shapes/circle',
        actor: 'header:jane',
        href: '/releases/timeline?repo=work%3Ashapes%2Fcircle',
      },
    ])
  })

  test('analysed repositories are not flagged as not analysed', async () => {
    await store.analyses.add({
      repo: { forge: 'work', path: 'shapes/circle' },
      kind: 'audit',
      createdAt: hoursAgo(2),
      data: {
        scanner: 'osv-scanner',
        findings: [
          {
            id: 'GHSA-1',
            aliases: [],
            summary: 'widget overflow',
            severity: 'critical',
            url: 'https://osv.dev/GHSA-1',
            package: { name: 'some-lib', version: '1.0.0', ecosystem: 'npm' },
            source: 'pnpm-lock.yaml',
            fixedVersions: ['1.0.1'],
          },
        ],
        ignored: [],
        expired: [],
        fixes: [],
        resolved: [],
        changedFiles: [],
      },
    })
    const home = await read(asShapes)
    expect(home.attention.map((item) => item.kind)).toEqual([])
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
    expect(home.spend?.forecastUsd).toBeGreaterThan(6)
    expect(home.spend?.automaticStopsAt).toBeUndefined()
  })

  test('spend forecasts the rest of the week from past weeks and when automatic work stops', async () => {
    await usage('review', 6)
    await usage('review', 200, hoursAgo(165))
    const home = await read({}, app(noAuth()))
    expect(home.spend).toMatchObject({ spentUsd: 6, forecastUsd: 206 })
    const stopsAt = Date.parse(home.spend?.automaticStopsAt ?? '')
    expect(stopsAt).toBeGreaterThan(now.getTime())
    expect(stopsAt).toBeLessThan(Date.parse(home.spend!.week.to))
  })

  test('attention items the caller snoozed are marked, at once and until the snooze runs out', async () => {
    const server = app()
    await failJob('shapes/circle')
    const [item] = (await read(asShapes, server)).attention
    expect(item?.id).toBe('job-failures:widgets:widget exploded')
    expect(item?.snoozed).toBeUndefined()
    const until = new Date(now.getTime() + 3_600_000).toISOString()
    await addSnooze(store.kv!, 'header:jane', { id: item!.id, until }, now)
    await addSnooze(
      store.kv!,
      'someone-else',
      { id: 'not-analysed:work:shapes/circle', until },
      now,
    )
    expect((await read(asShapes, server)).attention.map((each) => each.snoozed)).toEqual([
      true,
      undefined,
    ])
    clock = new Date(now.getTime() + 2 * 3_600_000)
    expect((await read(asShapes, server)).attention.map((each) => each.snoozed)).toEqual([
      undefined,
      undefined,
    ])
  })

  test('answers stay cached per principal for half a minute', async () => {
    const server = app()
    expect((await read(asShapes, server)).attention).toEqual([])
    await failJob('shapes/circle')
    expect((await read(asShapes, server)).attention).toEqual([])
    clock = new Date(now.getTime() + 31_000)
    expect((await read(asShapes, server)).attention).toHaveLength(2)
  })
})
