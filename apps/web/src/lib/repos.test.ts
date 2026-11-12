import { describe, expect, test } from 'bun:test'

import type { RepoSummary } from '@holtkeeper/api'

import {
  filterRepos,
  cellTarget,
  fleetKeyCommand,
  fleetSortValue,
  fleetStrip,
  globMatcher,
  groupMembership,
  groupRows,
  healthSummaryText,
  membershipChangeText,
  parseReposSearch,
  patternChanges,
  pickGroupTab,
  reposSort,
  stepKey,
  suggestGroup,
  updatesText,
  withReposSort,
  worstFirst,
} from './repos.ts'
import { sortRows } from './table-sort.ts'

const repo = (path: string, extra: Partial<RepoSummary> = {}): RepoSummary => ({
  repo: { forge: 'gitlab.acme.dev', path },
  groups: ['web'],
  health: 'healthy',
  cells: {},
  ...extra,
})

const NOW = new Date('2026-11-12T12:00:00.000Z')

describe('search parameters', () => {
  test('keeps known values and drops the rest', () => {
    expect(
      parseReposSearch({
        q: 'widget',
        group: ['web', '', 'web', 'payments'],
        health: 'failing,bogus',
        forge: 'github.com',
        sort: 'coverage',
        dir: 'desc',
      }),
    ).toEqual({
      q: 'widget',
      health: ['failing'],
      forge: ['github.com'],
      sort: 'coverage',
      dir: 'desc',
    })
    expect(parseReposSearch({ sort: 'size', q: '', group: 3 })).toEqual({})
    expect(parseReposSearch({ sort: 'repo' })).toEqual({ sort: 'repo', dir: 'asc' })
  })

  test('the sort round-trips and clears back to worst first', () => {
    const search = withReposSort({ q: 'a' }, { key: 'analysed', direction: 'desc' })
    expect(search).toEqual({ q: 'a', sort: 'analysed', dir: 'desc' })
    expect(reposSort(search)).toEqual({ key: 'analysed', direction: 'desc' })
    expect(withReposSort(search, null)).toEqual({ q: 'a' })
    expect(reposSort({})).toBeNull()
  })
})

const fleet = [
  repo('acme/widget-kit', { repo: { forge: 'github.com', path: 'acme/widget-kit' } }),
  repo('acme/ledger-api', { groups: ['payments'], health: 'failing' }),
  repo('acme/checkout-web', { groups: ['web', 'payments'], health: 'warnings' }),
]

const paths = (search: Parameters<typeof filterRepos>[1]) =>
  filterRepos(fleet, search).map((r) => r.repo.path)

const audit = (critical: number, high: number, active: number) =>
  ({ severities: { critical, high, medium: 0, low: 0, unknown: 0 }, active }) as never

const only = (actions: string[]) => (action: string) => actions.includes(action)

describe('filtering and sorting', () => {
  test('filters by text over path and groups, health and forge', () => {
    expect(paths({ q: 'PAY' })).toEqual(['acme/ledger-api', 'acme/checkout-web'])
    expect(paths({ q: 'github.com:acme' })).toEqual(['acme/widget-kit'])
    expect(paths({ q: 'payments', health: ['warnings'] })).toEqual(['acme/checkout-web'])
    expect(paths({ forge: ['gitlab.acme.dev'] })).toEqual(['acme/ledger-api', 'acme/checkout-web'])
  })

  test('worst first by default; cells sort by tone with absent cells last', () => {
    expect(worstFirst(fleet).map((r) => r.health)).toEqual(['failing', 'warnings', 'healthy'])
    const cells = [
      repo('acme/a', { cells: { coverage: { value: '81%', sub: '', tone: 'ok' } } }),
      repo('acme/b'),
      repo('acme/c', { cells: { coverage: { value: '40%', sub: '', tone: 'bad' } } }),
    ]
    const sorted = (direction: 'asc' | 'desc') =>
      sortRows(cells, { key: 'coverage', direction }, fleetSortValue).map((r) => r.repo.path)
    expect(sorted('asc')).toEqual(['acme/c', 'acme/a', 'acme/b'])
    expect(sorted('desc')).toEqual(['acme/a', 'acme/c', 'acme/b'])
    expect(
      fleetSortValue(repo('acme/x', { lastAnalysedAt: NOW.toISOString() }), 'analysed'),
    ).toEqual(NOW)
  })
})

describe('summary strip', () => {
  test('counts states, recent analyses, urgent findings and updates', () => {
    const cells = fleetStrip(
      [
        repo('acme/a', {
          health: 'failing',
          freshness: { current: 1, total: 2 },
          lastAnalysedAt: '2026-11-11T00:00:00.000Z',
          latestAudit: audit(1, 0, 3),
          updates: { via: 'webhook' },
        }),
        repo('acme/b', {
          health: 'not-analysed',
          freshness: { current: 0, total: 0 },
          latestAudit: audit(0, 0, 1),
          updates: { via: 'polling', intervalMs: 300_000 },
        }),
        repo('acme/c', {
          lastAnalysedAt: '2026-10-01T00:00:00.000Z',
          freshness: { current: 3, total: 3 },
        }),
      ],
      'in my teams',
      NOW,
    )
    expect(cells.map((cell) => `${cell.value as number} ${cell.label as string}`)).toEqual([
      '3 repositories in my teams',
      '1 healthy',
      '0 with warnings',
      '1 failing',
      '1 not analysed',
      '1 analysed this week',
      '1 with critical or high',
      '4 active findings',
      '1 webhook',
    ])
    expect(cells.at(-1)).toMatchObject({ prefix: 'Updates', caption: '· 1 polling', end: true })
  })

  test('leaves out figures the viewer may not read', () => {
    expect(fleetStrip([repo('acme/a')], undefined, NOW).map((c) => c.label)).toEqual([
      'repository',
      'healthy',
      'with warnings',
      'failing',
      'not analysed',
    ])
  })

  test('texts for the folded row and updates', () => {
    expect(healthSummaryText([repo('a/b'), repo('a/c', { health: 'not-analysed' })])).toBe(
      '1 healthy · 0 with warnings · 0 failing · 1 not analysed',
    )
    expect(updatesText(undefined)).toEqual({ text: '—', tone: 'none' })
    expect(updatesText({ via: 'polling', intervalMs: 300_000 }).text).toBe('Polling · 5m')
    expect(updatesText({ via: 'polling', lastError: 'boom' })).toEqual({
      text: 'Poll failed',
      tone: 'danger',
    })
    expect(updatesText({ via: 'webhook' })).toEqual({ text: 'Webhook', tone: 'success' })
  })
})

test('J and K step through rows and stop at the ends', () => {
  const keys = ['a', 'b', 'c']
  expect(stepKey(keys, undefined, 'next')).toBe('a')
  expect(stepKey(keys, undefined, 'previous')).toBe('c')
  expect(stepKey(keys, 'b', 'next')).toBe('c')
  expect(stepKey(keys, 'c', 'next')).toBe('c')
  expect(stepKey(keys, 'a', 'previous')).toBe('a')
  expect(stepKey(keys, 'gone', 'next')).toBe('a')
  expect(stepKey([], 'a', 'next')).toBeUndefined()
})

test('J, K and Enter drive the table except while typing or in a dialog', () => {
  expect(fleetKeyCommand({ key: 'j' })).toBe('next')
  expect(fleetKeyCommand({ key: 'K' })).toBe('previous')
  expect(fleetKeyCommand({ key: 'Enter' })).toBe('open')
  expect(fleetKeyCommand({ key: 'Escape' })).toBeUndefined()
  expect(fleetKeyCommand({ key: 'j', editable: true })).toBeUndefined()
  expect(fleetKeyCommand({ key: 'Enter', inDialog: true })).toBeUndefined()
  expect(fleetKeyCommand({ key: 'k', metaKey: true })).toBeUndefined()
})

test('group rows merge configured groups with the groups of visible repositories', () => {
  const rows = groupRows(
    [repo('acme/a', { health: 'failing' }), repo('acme/b', { groups: ['web', 'platform'] })],
    [{ id: 'payments', data: { forge: 'gitlab.acme.dev', include: ['acme/pay-*'], exclude: [] } }],
  )
  expect(rows.map((row) => [row.id, row.forge, row.members.length, row.counts.failing])).toEqual([
    ['payments', 'gitlab.acme.dev', 0, 0],
    ['platform', 'gitlab.acme.dev', 1, 0],
    ['web', 'gitlab.acme.dev', 2, 1],
  ])
  expect(rows[0]?.groups).toEqual(['payments'])
})

test('group tabs follow permissions', () => {
  expect(pickGroupTab(only([]), 'membership')).toMatchObject({ tab: 'repos' })
  expect(pickGroupTab(only([]), undefined).tabs.map((t) => t.id)).toEqual(['repos'])
  const reader = pickGroupTab(only(['settings:read', 'analyses:read']), 'membership')
  expect(reader.tab).toBe('membership')
  expect(reader.tabs.map((t) => t.id)).toEqual(['repos', 'stack', 'settings', 'membership'])
  const partial = pickGroupTab(only(['settings:read']), 'membership', only([]))
  expect(partial.tab).toBe('repos')
  expect(partial.tabs.map((t) => t.id)).toEqual(['repos', 'settings'])
})

describe('group patterns', () => {
  test('globs match like the server: * in one segment, ** across, classes and braces', () => {
    expect(globMatcher('acme/*')('acme/widget-kit')).toBe(true)
    expect(globMatcher('acme/*')('acme/web/widget-kit')).toBe(false)
    expect(globMatcher('acme/**')('acme/web/widget-kit')).toBe(true)
    expect(globMatcher('acme/**/kit')('acme/kit')).toBe(true)
    expect(globMatcher('acme/{ledger,billing}-*')('acme/billing-worker')).toBe(true)
    expect(globMatcher('acme/{ledger,billing}-*')('acme/notify-svc')).toBe(false)
    expect(globMatcher('acme/v[0-9]')('acme/v2')).toBe(true)
    expect(globMatcher('acme/a.b')('acme/aXb')).toBe(false)
    expect(globMatcher('acme/app?')('acme/app1')).toBe(true)
  })

  const forge = 'gitlab.acme.dev'
  const listed = ['acme/ledger-api', 'acme/ledger-legacy', 'acme/payout-svc', 'acme/billing-worker']
  const matched = listed.map((path) => ({ forge, path }))
  const saved = {
    include: ['acme/ledger-*', 'acme/billing-*', 'acme/fx-rates'],
    exclude: ['acme/*-legacy'],
  }

  test('members, excluded paths and exact paths before any listing', () => {
    const membership = groupMembership(
      forge,
      [...matched, { forge: 'github.com', path: 'acme/x' }],
      saved,
    )
    expect(
      membership.rows.map((row) => [row.repo.path, row.state, row.pattern, row.source]),
    ).toEqual([
      ['acme/billing-worker', 'member', 'acme/billing-*', 'listed'],
      ['acme/fx-rates', 'member', 'acme/fx-rates', 'exact'],
      ['acme/ledger-api', 'member', 'acme/ledger-*', 'listed'],
      ['acme/ledger-legacy', 'excluded', 'acme/*-legacy', 'listed'],
    ])
    expect(membership.counts).toEqual({
      include: {
        'acme/ledger-*': { members: 1, excluded: 1 },
        'acme/billing-*': { members: 1, excluded: 0 },
        'acme/fx-rates': { members: 1, excluded: 0 },
      },
      exclude: { 'acme/*-legacy': 1 },
    })
    expect([membership.members, membership.excluded, membership.joins, membership.leaves]).toEqual([
      3, 1, 0, 0,
    ])
  })

  test('unsaved patterns preview who joins and who leaves on the last listing', () => {
    const draft = {
      include: ['acme/ledger-*', 'acme/payout-*', 'acme/fx-rates'],
      exclude: ['acme/*-legacy'],
    }
    const membership = groupMembership(forge, matched, saved, draft)
    expect(membership.rows.slice(0, 2).map((row) => [row.repo.path, row.state])).toEqual([
      ['acme/payout-svc', 'joins'],
      ['acme/billing-worker', 'leaves'],
    ])
    expect(membershipChangeText(membership)).toBe('adds 1 repository, removes 1 repository')
    expect(membershipChangeText({ joins: 0, leaves: 0 })).toBe(
      'changes no membership in the last listing',
    )
    expect(patternChanges(saved, draft)).toBe(2)
    expect(patternChanges(saved, saved)).toBe(0)
  })

  test('suggests the group whose patterns cover the most pasted paths', () => {
    const groups = [
      { id: 'payments', data: { forge, include: ['acme/ledger-*', 'acme/fx-rates'], exclude: [] } },
      { id: 'web', data: { forge, include: ['web/*'], exclude: [] } },
    ]
    expect(suggestGroup(['acme/ledger-core', 'acme/tax-rules'], groups)).toBe('payments')
    expect(suggestGroup(['web/storefront'], groups)).toBe('web')
    expect(suggestGroup(['tools/cli'], groups)).toBeUndefined()
  })
})

test('health cells open the matching hub area, jobs the runs', () => {
  const widget = { forge: 'gitlab', path: 'acme/widget' }
  const hub = { to: '/repos/$' as const, params: { _splat: 'gitlab/acme/widget' } }
  expect(cellTarget(widget, 'security')).toEqual({
    ...hub,
    search: { tab: 'supply', section: 'security' },
  })
  expect(cellTarget(widget, 'dependencies')).toEqual({
    ...hub,
    search: { tab: 'supply', section: 'libraries' },
  })
  expect(cellTarget(widget, 'licenses')).toEqual({
    ...hub,
    search: { tab: 'supply', section: 'licenses' },
  })
  expect(cellTarget(widget, 'coverage')).toEqual({
    ...hub,
    search: { tab: 'quality', section: 'coverage' },
  })
  expect(cellTarget(widget, 'bundles')).toEqual({
    ...hub,
    search: { tab: 'quality', section: 'bundles' },
  })
  expect(cellTarget(widget, 'ci')).toEqual({ ...hub, search: { tab: 'quality', section: 'ci' } })
  expect(cellTarget(widget, 'release')).toEqual({ ...hub, search: { tab: 'releases' } })
  expect(cellTarget(widget, 'jobs')).toEqual({
    to: '/ops/runs',
    search: { repo: 'gitlab:acme/widget' },
  })
})
