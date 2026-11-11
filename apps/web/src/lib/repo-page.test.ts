import { describe, expect, test } from 'bun:test'

import type { Action, AnalysisSummary, SettingView } from '@holtkeeper/api'

import {
  approvalShare,
  freshnessRows,
  groupTabs,
  inheritedEntry,
  inheritedFrom,
  overriddenKeys,
  pickTab,
  recordFreshness,
  repoTabs,
  stackHealth,
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

const tool = (support: 'eol' | 'eol-soon' | 'active') => ({
  id: support,
  name: support,
  declared: '1',
  file: '.nvmrc',
  support,
})

const entry = (id: string, key: string, scope: SettingView['scope']): SettingView => ({
  id,
  key,
  scope,
  value: id,
  secret: false,
  updatedAt: '2026-11-01T00:00:00.000Z',
})

describe('tabs', () => {
  test('repository tabs follow the reader’s permissions', () => {
    expect(visibleTabs(repoTabs, only('analyses:read')).map((t) => t.id)).toEqual([
      'overview',
      'assets',
      'reviews',
    ])
    expect(visibleTabs(repoTabs, only('knowledge:read', 'settings:read')).map((t) => t.id)).toEqual(
      ['guide', 'settings'],
    )
    expect(visibleTabs(repoTabs, only())).toEqual([])
  })

  test('the group page always has its repositories', () => {
    expect(visibleTabs(groupTabs, only()).map((t) => t.id)).toEqual(['repos'])
    expect(
      visibleTabs(groupTabs, only('analyses:read', 'knowledge:read', 'settings:read')).map(
        (t) => t.id,
      ),
    ).toEqual(['repos', 'guide', 'stack', 'settings'])
  })

  test('an unknown or hidden tab falls back to the first visible one', () => {
    const tabs = visibleTabs(repoTabs, only('analyses:read'))
    expect(pickTab(tabs, 'reviews')).toBe('reviews')
    expect(pickTab(tabs, 'settings')).toBe('overview')
    expect(pickTab(tabs, undefined)).toBe('overview')
    expect(pickTab([], 'overview')).toBeUndefined()
  })
})

describe('freshness', () => {
  const head = { sha: 'c'.repeat(40), at: '2026-11-10T00:00:00.000Z' }

  test('age first, then the sha against the known head', () => {
    expect(recordFreshness(record('a', '2026-10-01T00:00:00.000Z', head.sha), head, now)).toBe(
      'stale',
    )
    expect(recordFreshness(record('a', '2026-11-02T00:00:00.000Z'), head, now)).toBe('aging')
    expect(
      recordFreshness(record('a', '2026-11-10T00:00:00.000Z', 'a'.repeat(40)), head, now),
    ).toBe('behind')
    expect(recordFreshness(record('a', '2026-11-10T00:00:00.000Z', head.sha), head, now)).toBe(
      'current',
    )
    expect(recordFreshness(record('a', '2026-11-10T00:00:00.000Z'), head, now)).toBe('current')
    expect(recordFreshness(record('a', '2026-11-10T00:00:00.000Z', 'a'), undefined, now)).toBe(
      'current',
    )
  })

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
  })
})

test('stack health counts ending lines and failing conventions', () => {
  const conventions = { matches: 1, drifts: 0, missing: 0, error: 0 }
  expect(stackHealth({ checkedAt: '', tools: [tool('active')], conventions })).toEqual({
    ending: 0,
    tone: 'success',
  })
  expect(
    stackHealth({
      checkedAt: '',
      tools: [tool('active')],
      conventions: { ...conventions, missing: 1 },
    }).tone,
  ).toBe('warning')
  expect(
    stackHealth({ checkedAt: '', tools: [tool('eol'), tool('eol-soon')], conventions }),
  ).toEqual({ ending: 2, tone: 'danger' })
})

test('approval share ignores runs without reactions', () => {
  expect(approvalShare({ up: 0, down: 0 })).toBeUndefined()
  expect(approvalShare({ up: 3, down: 1 })).toBe(0.75)
})

describe('overrides', () => {
  const entries = [
    entry('all', 'polling', { all: true }),
    entry('shapes', 'polling', { groups: ['shapes'] }),
    entry('both', 'polling', { groups: [['shapes', 'colors']] }),
    entry('mine', 'polling', { repos: ['work:shapes/circle'] }),
    entry('other', 'toolchain', { groups: ['colors'] }),
  ]
  const focus = { kind: 'repo' as const, repo }

  test('the inherited entry is the most specific one covering the focus', () => {
    expect(inheritedEntry(entries, 'polling', focus, ['shapes'])?.id).toBe('shapes')
    expect(inheritedEntry(entries, 'polling', focus, ['shapes', 'colors'])?.id).toMatch(
      /shapes|both/,
    )
    expect(inheritedEntry(entries, 'polling', focus, [])?.id).toBe('all')
    expect(inheritedEntry(entries, 'toolchain', focus, ['shapes'])).toBeUndefined()
    expect(inheritedEntry(entries, 'polling', { kind: 'group', group: 'shapes' }, [])?.id).toBe(
      'all',
    )
  })

  test('labels where it comes from', () => {
    expect(inheritedFrom(entry('x', 'polling', { groups: ['shapes'] }))).toBe('group shapes')
    expect(inheritedFrom(entry('x', 'polling', { all: true }))).toBe('everything')
  })

  test('only keys with entries naming the focus count as overrides', () => {
    const definitions = [{ key: 'toolchain' }, { key: 'polling' }]
    expect(overriddenKeys(definitions, entries, focus)).toEqual(['polling'])
    expect(overriddenKeys(definitions, entries, { kind: 'group', group: 'colors' })).toEqual([
      'toolchain',
    ])
  })
})
