import { describe, expect, test } from 'bun:test'

import type { RepoSummary } from '@holtkeeper/api'

import {
  cellTarget,
  filterRepos,
  fleetKeyCommand,
  fleetSortValue,
  fleetStrip,
  folderAncestors,
  folderLabel,
  folderTree,
  healthSummaryText,
  inFolderKey,
  ownershipChange,
  ownershipChangeText,
  parseReposSearch,
  pickTeamTab,
  reposSort,
  stepKey,
  teamEditLevel,
  teamRows,
  toTeamDraft,
  toTeamInput,
  updatesText,
  withReposSort,
  worstFirst,
} from './repos.ts'
import { sortRows } from './table-sort.ts'

const repo = (path: string, extra: Partial<RepoSummary> = {}): RepoSummary => ({
  repo: { forge: 'gitlab.acme.dev', path },
  teams: ['web'],
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
        team: ['web', '', 'web', 'payments'],
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
    expect(parseReposSearch({ sort: 'size', q: '', team: 3 })).toEqual({})
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
  repo('acme/ledger-api', { teams: ['payments'], health: 'failing' }),
  repo('acme/checkout-web', { teams: ['web', 'payments'], health: 'warnings' }),
]

const paths = (search: Parameters<typeof filterRepos>[1]) =>
  filterRepos(fleet, search).map((r) => r.repo.path)

const audit = (critical: number, high: number, active: number) =>
  ({ severities: { critical, high, medium: 0, low: 0, unknown: 0 }, active }) as never

describe('filtering and sorting', () => {
  test('filters by text over path and teams, health and forge', () => {
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

describe('teams', () => {
  const widgets = {
    title: 'Widgets',
    owns: ['acme/round/**'],
    exclude: ['acme/round/legacy-*'],
    consumes: ['acme/shared/**'],
    members: [{ id: 'ann@acme.test', role: 'maintainer' as const }],
  }
  const listing = [
    repo('acme/round/web', { health: 'failing' }),
    repo('acme/round/legacy-api'),
    repo('acme/shared/kit'),
    repo('acme/square/web', { teams: ['gizmo'] }),
  ]

  test('rows count what each team owns and consumes by its patterns, or by owner teams', () => {
    const rows = teamRows(listing, [{ id: 'widgets', data: widgets }], (id) =>
      id === 'widgets' ? 'Widgets' : id,
    )
    expect(rows.map((row) => [row.id, row.repos.length, row.consumed, row.counts.failing])).toEqual(
      [
        ['gizmo', 1, 0, 0],
        ['web', 3, 0, 1],
        ['widgets', 1, 1, 1],
      ],
    )
    expect(rows[2]?.teams).toEqual(['widgets'])
    expect(rows[2]?.definition?.title).toBe('Widgets')
  })

  test('global settings:write edits everything, a maintainer only title and members', () => {
    expect(teamEditLevel([{ scope: { all: true }, actions: ['settings:write'] }], 'widgets')).toBe(
      'full',
    )
    expect(teamEditLevel([{ scope: { teams: ['widgets'] }, actions: ['*'] }], 'widgets')).toBe(
      'members',
    )
    expect(
      teamEditLevel([{ scope: { teams: ['widgets'] }, actions: ['settings:write'] }], 'widgets'),
    ).toBe('none')
    expect(teamEditLevel([{ scope: { teams: ['gizmo'] }, actions: ['*'] }], 'widgets')).toBe('none')
    expect(teamEditLevel([{ scope: { teams: ['widgets'] }, actions: ['*'] }], undefined)).toBe(
      'none',
    )
  })

  test('the draft round-trips; blanks and duplicates are dropped on save', () => {
    const draft = toTeamDraft('widgets', widgets)
    expect(toTeamInput(draft)).toEqual(widgets)
    expect(
      toTeamInput({
        ...draft,
        title: ' ',
        owns: [' acme/round/** ', 'acme/round/**', ''],
        members: [
          { id: ' bob@acme.test ', role: 'member' },
          { id: 'bob@acme.test', role: 'maintainer' },
          { id: '', role: 'member' },
        ],
      }),
    ).toEqual({
      owns: ['acme/round/**'],
      exclude: ['acme/round/legacy-*'],
      consumes: ['acme/shared/**'],
      members: [{ id: 'bob@acme.test', role: 'member' }],
    })
    expect(toTeamDraft()).toMatchObject({ id: '', owns: [], members: [] })
  })

  test('unsaved patterns preview who joins and who leaves', () => {
    const change = ownershipChange(listing, widgets, { owns: ['acme/**/web'], exclude: [] })
    expect(change.owned.map((r) => r.repo.path)).toEqual(['acme/round/web', 'acme/square/web'])
    expect(change.joins.map((r) => r.repo.path)).toEqual(['acme/square/web'])
    expect(change.leaves).toEqual([])
    expect(ownershipChangeText(change)).toBe('adds 1 repository')
    expect(ownershipChangeText({ joins: [], leaves: [1, 2] })).toBe('removes 2 repositories')
    expect(ownershipChangeText({ joins: [], leaves: [] })).toBe('')
  })

  test('team tabs follow permissions', () => {
    expect(pickTeamTab(() => true, 'stack').tab).toBe('stack')
    const limited = pickTeamTab((action) => action === 'repos:read', 'settings')
    expect(limited.tabs.map((tab) => tab.id)).toEqual(['repos'])
    expect(limited.tab).toBe('repos')
  })
})

describe('folder tree', () => {
  const refs = [
    { forge: 'work', path: 'acme/round/web' },
    { forge: 'work', path: 'acme/round/api' },
    { forge: 'work', path: 'acme/square/web' },
    { forge: 'work', path: 'solo' },
  ]

  test('every path prefix is a folder; a single forge hides its root', () => {
    const tree = folderTree(refs)
    expect(tree.map((node) => [node.folder, node.total])).toEqual([['acme', 3]])
    expect(tree[0]?.children.map((node) => [node.folder, node.name, node.total])).toEqual([
      ['acme/round', 'round', 2],
      ['acme/square', 'square', 1],
    ])
    const two = folderTree([...refs, { forge: 'home', path: 'acme/kit' }])
    expect(two.map((node) => [node.forge, node.folder, node.total])).toEqual([
      ['home', '', 1],
      ['work', '', 4],
    ])
  })

  test('folder keys select repositories below them and name their ancestors', () => {
    expect(inFolderKey(refs[0]!, 'work:acme/round')).toBe(true)
    expect(inFolderKey(refs[2]!, 'work:acme/round')).toBe(false)
    expect(inFolderKey(refs[3]!, 'work:')).toBe(true)
    expect(inFolderKey(refs[0]!, 'home:acme')).toBe(false)
    expect(folderAncestors('work:acme/round/web')).toEqual([
      'work:',
      'work:acme',
      'work:acme/round',
    ])
    expect(folderLabel('work:acme/round')).toBe('acme/round')
    expect(folderLabel('work:')).toBe('forge work')
  })

  test('the selected folder is a search parameter and filters the list', () => {
    expect(parseReposSearch({ folder: 'work:acme/round' })).toEqual({ folder: 'work:acme/round' })
    expect(parseReposSearch({ folder: 'acme' })).toEqual({})
    expect(
      filterRepos(
        refs.map((ref) => repo(ref.path, { repo: ref })),
        { folder: 'work:acme/round' },
      ).map((r) => r.repo.path),
    ).toEqual(['acme/round/web', 'acme/round/api'])
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
