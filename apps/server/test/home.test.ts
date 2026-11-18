import { beforeEach, describe, expect, test } from 'bun:test'

import { auditAnalysis } from '@holtkeeper/analyzers'
import type { FindingGroup, HomeView, ReleaseCard, SecuritySummary } from '@holtkeeper/api'
import { emptySeverities } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { AuditEvent, Job, Learning, SettingEntry, Store } from '@holtkeeper/store'
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
  urgentFindingItems,
} from '../src/home.ts'
import { addSnooze } from '../src/snoozes.ts'

const NOW = '2026-10-30T12:00:00.000Z'
const now = new Date(NOW)
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString()

const teamsOf = (repo: string) =>
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
  severities: Partial<SecuritySummary['severities']>,
  patch: Partial<SecuritySummary> = {},
): SecuritySummary => {
  const counts = { ...emptySeverities(), ...severities }
  return {
    analysisId: `audit-${path}`,
    createdAt: hoursAgo(3),
    severities: counts,
    active: Object.values(counts).reduce((a, b) => a + b, 0),
    ignored: 0,
    expiredAllowlist: 0,
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
  teamsOf,
  analyzerLabel: (kind) => (kind === 'widgets' ? 'Widgets' : kind),
  failedJobs: [],
  blockedJobs: [],
  audits: [],
  releases: [],
  learnings: [],
  analyses: [],
  allowlists: [],
  repos: [],
  ...patch,
})

const learning = (id: string, repo: string | undefined, createdAt: string): Learning => ({
  id,
  text: 'Prefer widgets over gadgets',
  key: id,
  scope: repo ? { repos: [repo] } : { all: true },
  origin: 'reply',
  status: 'pending',
  sources: [],
  createdAt,
  updatedAt: createdAt,
  activeAt: createdAt,
  lastReinforcedAt: createdAt,
  uses: 0,
  actedOn: 0,
  votesUp: 0,
  votesDown: 0,
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

const findingGroup = (advisory: string, urgent: boolean, statuses: string[]): FindingGroup => ({
  advisory,
  aliases: [],
  package: 'some-lib',
  ecosystem: 'npm',
  severity: 'critical',
  fixedIn: ['2.0.0'],
  repos: statuses.map((status, index) => ({
    repo: index ? 'work:colors/red' : 'work:shapes/circle',
    teams: [],
    versions: ['1.0.0'],
    sources: ['package-lock.json'],
    status: status as 'open' | 'allowlisted',
  })),
  status: 'open',
  firstSeenAt: '2026-10-29T00:00:00.000Z',
  urgency: {
    urgent,
    category: 'code-execution',
    reason: 'Runs code from untrusted widgets.\nMore words.',
    by: 'ai',
    at: '2026-10-29T10:00:00.000Z',
  },
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
      { repo: 'work:shapes/circle', teams: ['shapes'] },
      { repo: 'work:colors/red', teams: ['colors'] },
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

  test('a team analysis failure belongs to the team it ran for', () => {
    const items = failureItems(
      sources({
        failedJobs: [job({ path: 'round', group: 'round', errorSignature: 'sig-d' })],
      }),
    )
    expect(items[0]?.repos).toEqual([{ repo: 'work:round', teams: ['round'] }])
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
            repo: { forge: 'work', path: 'shapes/circle' },
            latest: summary('shapes/circle', { critical: 1, high: 2 }, { expiredAllowlist: 2 }),
            previous: summary('shapes/circle', { high: 1 }),
          },
          {
            repo: { forge: 'work', path: 'colors/red' },
            latest: summary('colors/red', { medium: 4 }),
          },
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
    expect(items[0]?.href).toBe('/supply/security?repo=work%3Ashapes%2Fcircle')
    expect(items[0]?.action).toEqual({
      type: 'open',
      label: 'Open findings',
      href: '/supply/security?repo=work%3Ashapes%2Fcircle',
    })
  })

  test('urgent findings come first among critical items and open the finding sheet', () => {
    const urgentFindings = [
      findingGroup('GHSA-1', true, ['open', 'allowlisted']),
      findingGroup('GHSA-2', false, ['open']),
    ]
    expect(urgentFindingItems(sources({ urgentFindings }))).toEqual([
      {
        id: 'urgent-vulnerability:GHSA-1|npm|some-lib',
        kind: 'urgent-vulnerability',
        severity: 'critical',
        title: 'Urgent: some-lib (GHSA-1)',
        detail: 'Runs code from untrusted widgets.',
        repos: [expect.objectContaining({ repo: 'work:shapes/circle' })],
        count: 1,
        at: '2026-10-29T10:00:00.000Z',
        href: '/supply/security?urgent=only&finding=GHSA-1%3Asome-lib',
        action: {
          type: 'open',
          label: 'Open finding',
          href: '/supply/security?urgent=only&finding=GHSA-1%3Asome-lib',
        },
      },
    ])
    const all = attentionItems(
      sources({
        urgentFindings,
        audits: [
          {
            repo: { forge: 'work', path: 'shapes/circle' },
            latest: summary('shapes/circle', { critical: 1 }),
          },
        ],
      }),
    )
    expect(all.map((item) => item.kind)).toEqual(['urgent-vulnerability', 'vulnerabilities'])
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
      repos: [{ repo: 'work:shapes/circle', teams: ['shapes'] }],
      at: '2026-10-23T00:00:00.000Z',
      href: '/inbox?item=allowlist%3As1%3AGHSA-old&kind=allowlist',
    })
    expect(items[1]?.action).toEqual({
      type: 'renew',
      label: 'Renew',
      href: '/inbox?item=allowlist%3As1%3AGHSA-soon%3Asome-lib&kind=allowlist',
    })
  })

  test('releases that need a person become items; states with no decision do not', () => {
    const items = releaseItems(
      sources({
        releases: [
          card('shapes/circle', {
            stage: 'awaiting-version',
            needsAction: true,
            unreleased: 2,
            next: '1.3.0',
            acceptanceRequired: true,
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
          card('shapes/oval', {
            stage: 'awaiting-version',
            needsAction: true,
            unreleased: 2,
            next: '2.0.0',
            blockers: ['The target pipeline failed'],
          }),
          card('colors/red', { stage: 'idle' }),
          card('colors/blue', { stage: 'candidate', needsAction: true, ahead: 3 }),
          card('colors/green', {
            stage: 'awaiting-version',
            needsAction: true,
            unreleased: 4,
            next: '1.1.0',
          }),
          card('colors/teal', {
            stage: 'awaiting-version',
            needsAction: true,
            unreleased: 4,
            next: '1.7.0',
            acceptanceRequired: true,
            acceptance: { sha: 'abc', by: 'u1', at: hoursAgo(1), via: 'manual' },
          }),
          card('colors/plum', {
            stage: 'proposed',
            needsAction: true,
            acceptanceRequired: true,
            request: { id: 8, title: 'Release', webUrl: 'https://forge.test/mr/8', draft: false },
          }),
        ],
      }),
    )
    expect(items.map((item) => [item.title, item.severity, item.href])).toEqual([
      [
        'Changes wait for acceptance before version 1.3.0',
        'medium',
        '/releases/timeline?repo=work%3Ashapes%2Fcircle',
      ],
      ['Deploy of v1.2.0 to prod failed', 'high', '/releases/timeline?repo=work%3Ashapes%2Fsquare'],
      [
        'Creating version 2.0.0 is blocked: The target pipeline failed',
        'medium',
        '/releases/timeline?repo=work%3Ashapes%2Foval',
      ],
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
            stage: 'awaiting-version',
            needsAction: true,
            unreleased: 2,
            acceptanceRequired: true,
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
      audits: [{ repo: { forge: 'work', path: 'colors/red' }, latest: summary('colors/red', {}) }],
    }
    expect(notAnalysedItems(sources(base)).map((item) => [item.id, item.title])).toEqual([
      ['not-analysed:work:colors/blue', 'Not analysed yet'],
      ['not-analysed:work:shapes/square', 'Not analysed yet'],
    ])
    const [square] = notAnalysedItems(
      sources({
        ...base,
        access: (repo) => (action) => action !== 'analyses:read' || repo.teams.includes('shapes'),
      }),
    )
    expect(square).toMatchObject({
      kind: 'not-analysed',
      severity: 'low',
      repos: [{ repo: 'work:shapes/square', teams: ['shapes'] }],
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
        audits: [
          {
            repo: { forge: 'work', path: 'colors/red' },
            latest: summary('colors/red', { critical: 1 }),
          },
        ],
        repos: ['work:colors/teal'],
        learnings: [learning('k1', undefined, hoursAgo(4))],
      }),
    )
    expect(items.map((item) => item.kind)).toEqual([
      'vulnerabilities',
      'budget-blocked',
      'job-failures',
      'learnings',
      'not-analysed',
    ])
    expect(items[1]?.href).toBe('/ops/runs?status=blocked')
    expect(items[3]).toMatchObject({
      repos: [],
      title: '1 learned rule waits for review',
      href: '/inbox?item=learning%3Ak1&kind=learning',
      action: { type: 'review', href: '/inbox?item=learning%3Ak1&kind=learning' },
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
        { ...event('rule.update', hoursAgo(1)), outcome: 'denied' },
      ],
      teamsOf,
    )
    expect(changes).toEqual([
      {
        id: `release.versioned-${hoursAgo(1)}`,
        kind: 'release',
        text: 'Cut version 1.4.0 of shapes/circle',
        href: '/releases/timeline?repo=work%3Ashapes%2Fcircle',
        at: hoursAgo(1),
        actor: 'u2',
        repo: { repo: 'work:shapes/circle', teams: ['shapes'] },
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
        repo: { repo: 'work:shapes/circle', teams: ['shapes'] },
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
      teamsOf,
    )
    expect(changes.map((change) => change.text)).toEqual([
      'Accepted the release of shapes/circle',
      'Proposed a release of shapes/circle',
      'Cut version 2.0.0 of shapes/circle',
    ])
  })

  test('release dismissals and allowlist renewals are changes', () => {
    const changes = summarizeChanges(
      [
        event('release.dismiss', hoursAgo(2), 'work:colors/red', 'u1', { sha: 'abc123' }),
        event('allowlist.renew', hoursAgo(3), undefined, 'u1', {
          key: 'audit.allowlist',
          advisory: 'GHSA-1234',
        }),
      ],
      teamsOf,
    )
    expect(changes.map((change) => [change.kind, change.text, change.href])).toEqual([
      [
        'release',
        'Dismissed the waiting release of colors/red',
        '/releases/timeline?repo=work%3Acolors%2Fred',
      ],
      ['settings', 'Renewed the allowlist entry for GHSA-1234', '/supply/security'],
    ])
  })

  test('learning decisions and rule edits are changes', () => {
    const changes = summarizeChanges(
      [
        {
          ...event('learning.approve', hoursAgo(1), 'work:shapes/circle'),
          target: { type: 'learning', id: 'l-1', repo: 'work:shapes/circle' },
        },
        { ...event('learning.reject', hoursAgo(2)), target: { type: 'learning', id: 'l-2' } },
        { ...event('learning.update', hoursAgo(2)), target: { type: 'learning', id: 'l-3' } },
        { ...event('rule.update', hoursAgo(3)), target: { type: 'rule', id: 'r-1' } },
        { ...event('rule.delete', hoursAgo(4)), target: { type: 'rule', id: 'r-2' } },
      ],
      teamsOf,
    )
    expect(changes.map((change) => [change.text, change.href])).toEqual([
      ['Approved a learned rule for shapes/circle', '/knowledge/learnings?learning=l-1'],
      ['Rejected a learned rule', '/knowledge/learnings?learning=l-2'],
      ['Edited a team rule', '/knowledge/rules?rule=r-1'],
      ['Deleted a team rule', '/knowledge/rules'],
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
      teamsOf,
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
      teamsOf,
    )
    expect(deploy?.text).toBe('Started deploying v1.2.0 of shapes/circle to prod')
    expect(deleted?.text).toBe('Removed a setting')
  })

  test('keeps the newest events up to the limit', () => {
    const events = Array.from({ length: 5 }, (_, index) =>
      event('repo.discover', hoursAgo(index + 1), `work:shapes/s${index}`, 'system'),
    )
    const changes = summarizeChanges(events, teamsOf, 2)
    expect(changes.map((change) => [change.text, change.href])).toEqual([
      ['Found the new repository shapes/s0', '/repos/work/shapes/s0'],
      ['Found the new repository shapes/s1', '/repos/work/shapes/s1'],
    ])
  })
})

describe('GET /api/home', () => {
  const config = parseConfig({
    forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => ({}) as never } },
    teams: {
      shapes: { owns: ['work:shapes/*', 'work:shapes/circle'] },
      colors: { owns: ['work:colors/*'] },
    },
  })
  const auth = headerAuth({
    roles: {
      shapes: [{ scope: { teams: ['shapes'] }, actions: ['analyses:read', 'audits:read'] }],
      runners: [
        {
          scope: { teams: ['shapes'] },
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
      teams: ['shapes'],
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
    expect(home.attention.map((item) => item.kind)).toEqual(['vulnerabilities'])
  })

  test('an audit turned off leaves its vulnerabilities and stale records out', async () => {
    const finding = {
      id: 'GHSA-1',
      aliases: [],
      summary: 'widget overflow',
      severity: 'critical' as const,
      url: 'https://osv.dev/GHSA-1',
      package: { name: 'some-lib', version: '1.0.0', ecosystem: 'npm' },
      source: 'pnpm-lock.yaml',
      fixedVersions: ['1.0.1'],
    }
    const report = {
      scanner: 'osv-scanner',
      findings: [finding],
      ignored: [],
      expired: [],
      fixes: [],
      resolved: [],
      changedFiles: [],
    }
    await store.analyses.add({
      repo: { forge: 'work', path: 'shapes/circle' },
      kind: 'audit',
      createdAt: '2026-09-01T00:00:00.000Z',
      data: { ...report, findings: [] },
    })
    await store.analyses.add({
      repo: { forge: 'work', path: 'shapes/circle' },
      kind: 'audit',
      createdAt: '2026-10-01T00:00:00.000Z',
      data: report,
    })
    const before = (await read(asShapes)).attention
    expect(before.map((item) => item.kind)).toEqual(['vulnerabilities', 'stale-analyses'])
    expect(before[0]?.detail).toBe('Up from 0 in the audit before')
    await store.settings.put({
      id: 'off',
      key: 'repo.analyzers',
      scope: { repos: ['shapes/circle'] },
      value: { off: ['audit'], reason: 'Values only' },
      secret: false,
      updatedAt: hoursAgo(1),
    })
    clock = new Date(now.getTime() + 60_000)
    expect((await read(asShapes)).attention.map((item) => item.kind)).not.toContain(
      'vulnerabilities',
    )
    expect((await read(asShapes)).attention.map((item) => item.kind)).not.toContain(
      'stale-analyses',
    )
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
