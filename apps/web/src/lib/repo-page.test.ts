import { describe, expect, test } from 'bun:test'

import type { Action, AnalysisSummary } from '@holtkeeper/api'

import {
  approvalShare,
  accessText,
  cardTarget,
  deliveryCards,
  freshnessRows,
  freshnessTally,
  hubSearch,
  pickTab,
  qualitySections,
  repoTabs,
  supplySections,
  updatesBadge,
  visibleTabs,
} from './repo-page.ts'

const now = new Date('2026-11-11T12:00:00.000Z')
const repo = { forge: 'work', path: 'shapes/circle' }
const record = (kind: string, createdAt: string, sha?: string): AnalysisSummary => ({
  id: kind,
  repo,
  kind,
  label: kind,
  createdAt,
  ...(sha ? { sha } : {}),
  metrics: [],
})
const only =
  (...actions: Action[]) =>
  (action: Action) =>
    actions.includes(action)

describe('tabs', () => {
  test('hub tabs follow the reader’s permissions', () => {
    expect(visibleTabs(repoTabs, only('analyses:read')).map((t) => t.id)).toEqual([
      'overview',
      'supply',
      'quality',
    ])
    expect(visibleTabs(repoTabs, only('audits:read')).map((t) => t.id)).toEqual(['supply'])
    expect(
      visibleTabs(repoTabs, only('repos:read', 'knowledge:read', 'settings:read')).map((t) => t.id),
    ).toEqual(['activity', 'knowledge', 'settings'])
    expect(visibleTabs(repoTabs, only('releases:read')).map((t) => t.id)).toEqual(['releases'])
    expect(visibleTabs(repoTabs, only())).toEqual([])
  })

  test('an unknown or hidden tab falls back to the first visible one', () => {
    const tabs = visibleTabs(repoTabs, only('analyses:read'))
    expect(pickTab(tabs, 'quality')).toBe('quality')
    expect(pickTab(tabs, 'settings')).toBe('overview')
    expect(pickTab(tabs, undefined)).toBe('overview')
    expect(pickTab([], 'overview')).toBeUndefined()
  })

  test('areas of Supply chain and Quality', () => {
    expect(visibleTabs(supplySections, only('analyses:read')).map((s) => s.id)).toEqual([
      'libraries',
      'licenses',
      'stack',
      'public-api',
    ])
    expect(visibleTabs(supplySections, only('audits:read')).map((s) => s.id)).toEqual(['security'])
    expect(qualitySections.map((s) => s.id)).toEqual([
      'coverage',
      'bundles',
      'assets',
      'ci',
      'branches',
      'reviews',
    ])
    expect(pickTab(qualitySections, 'assets')).toBe('assets')
    expect(pickTab(qualitySections, 'nope')).toBe('coverage')
  })

  test('hub links leave the default tab and empty sections out', () => {
    expect(hubSearch('overview')).toEqual({})
    expect(hubSearch('settings', 'updates')).toEqual({ tab: 'settings', section: 'updates' })
    expect(hubSearch('quality', '')).toEqual({ tab: 'quality' })
    expect(cardTarget({ key: 'ci', section: 'quality' })).toEqual({ tab: 'quality', section: 'ci' })
    expect(cardTarget({ key: 'security', section: 'supply' })).toEqual({
      tab: 'supply',
      section: 'security',
    })
  })
})

describe('freshness', () => {
  const head = { sha: 'c'.repeat(40), at: '2026-11-10T00:00:00.000Z' }

  test('rows list the most worrying records first', () => {
    const rows = freshnessRows(
      {
        head,
        analyses: [
          record('licenses', '2026-11-10T00:00:00.000Z', head.sha),
          record('coverage', '2026-11-10T00:00:00.000Z', 'a'.repeat(40)),
          record('branches', '2026-09-01T00:00:00.000Z'),
        ],
      },
      now,
    )
    expect(rows.map((row) => [row.record.kind, row.freshness])).toEqual([
      ['branches', 'stale'],
      ['coverage', 'behind'],
      ['licenses', 'current'],
    ])
    expect(freshnessTally(rows)).toEqual({ current: 1, behind: 1, aging: 0, bad: 1 })
    expect(
      freshnessTally([{ freshness: 'failed' }, { freshness: 'aging' }, { freshness: 'never' }]),
    ).toEqual({ current: 0, behind: 0, aging: 1, bad: 1 })
  })
})

describe('delivery cards', () => {
  const base = {
    cells: {},
    reviews30d: { reviews: 0, posted: 0, resolved: 0, up: 0, down: 0, costUsd: 0 },
    work: { runs: 0, failed: 0, awaitingApproval: 0, costUsd: 0 },
  }

  test('quiet repository without releases or knowledge access', () => {
    expect(deliveryCards(base, false, now).map((card) => [card.key, card.status])).toEqual([
      ['reviews', 'No reviews'],
      ['work', 'Quiet'],
    ])
    expect(deliveryCards(base, true, now)[0]).toMatchObject({ key: 'releases', status: 'Off' })
  })

  test('runs without task or spend access leave those lines out', () => {
    const work = deliveryCards({ ...base, work: { runs: 3, failed: 1 } }, false, now)[1]
    expect(work).toMatchObject({ status: '1 failed', lines: ['1 failed'] })
  })

  test('release, reviews, work and knowledge', () => {
    const cards = deliveryCards(
      {
        cells: { release: { value: 'Waiting', sub: '', tone: 'warn' } },
        release: {
          stage: 'released',
          latest: { tag: 'v2.13.2', version: '2.13.2', sha: 'a', date: '2026-11-01T00:00:00.000Z' },
          next: '2.14.0',
          bump: 'minor',
          unreleased: 18,
          unreleasedCapped: false,
          deployed: { environment: 'production', at: '2026-11-11T10:00:00.000Z' },
        },
        reviews30d: { reviews: 20, posted: 57, resolved: 41, up: 6, down: 1, costUsd: 3.4 },
        work: { runs: 23, failed: 0, awaitingApproval: 1, costUsd: 6.4 },
        knowledge: { sections: 14, notes: 3, proposed: 0, inherits: ['group web'] },
      },
      true,
      now,
    )
    expect(cards.map((card) => [card.key, card.tone, card.status, card.value])).toEqual([
      ['releases', 'warn', 'Waiting', 'v2.13.2'],
      ['reviews', 'ok', '86% helpful', '20'],
      ['work', 'warn', '1 needs approval', '23'],
      ['knowledge', 'ok', 'Written', '14'],
    ])
    expect(cards[0]?.lines).toEqual(['Next 2.14.0 · minor', 'production deploy 2 hours ago'])
    expect(cards[1]?.segments).toEqual([
      { tone: 'ok', share: 0.857 },
      { tone: 'bad', share: 0.143 },
    ])
    expect(cards[1]?.lines).toEqual(['57 comments posted · 41 resolved', 'Spend $3.40'])
    expect(cards[3]?.lines).toEqual(['3 notes · 0 learnings proposed', 'Inherits group web'])
  })
})

describe('header and facts', () => {
  const polling = {
    enabled: true,
    intervalMs: 300_000,
    events: [],
    key: 'k',
    attempts: [],
  }

  test('updates badge prefers errors, then webhooks, then polling', () => {
    expect(
      updatesBadge({ viaWebhook: true, polling: { ...polling, lastError: 'boom' } }, now),
    ).toEqual({ tone: 'bad', text: 'Poll failed' })
    expect(
      updatesBadge({ viaWebhook: true, webhookSeenAt: '2026-11-11T11:56:00.000Z', polling }, now),
    ).toEqual({ tone: 'ok', text: 'Webhook OK · 4 minutes ago' })
    expect(updatesBadge({ viaWebhook: false, polling }, now)).toEqual({
      tone: 'info',
      text: 'Polling',
    })
    expect(updatesBadge({ viaWebhook: false, polling: { ...polling, enabled: false } })).toEqual({
      tone: 'none',
      text: 'Off',
    })
  })

  test('access in words', () => {
    expect(accessText({ readOnly: true, reason: 'Code freeze', writeTasks: false })).toBe(
      'Read-only · Code freeze',
    )
    expect(accessText({ readOnly: false, writeTasks: true })).toBe(
      'Read and write · agents may open merge requests',
    )
    expect(accessText({ readOnly: false, writeTasks: false })).toBe(
      'Read and write · write tasks off',
    )
  })
})

test('approval share ignores runs without reactions', () => {
  expect(approvalShare({ up: 0, down: 0 })).toBeUndefined()
  expect(approvalShare({ up: 3, down: 1 })).toBe(0.75)
})
