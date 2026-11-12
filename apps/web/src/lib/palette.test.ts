import { expect, test } from 'bun:test'

import type {
  DependencySearchHit,
  PublicApiSymbolHit,
  RepoSummary,
  SettingDefinitionView,
  UserView,
} from '@holtkeeper/api'

import {
  type PaletteItem,
  type RecentItem,
  type RecentStorage,
  actionItems,
  buildResults,
  clearRecent,
  highlight,
  isPaletteShortcut,
  libraryItems,
  moveSelection,
  pageItems,
  parseQuery,
  peopleItems,
  rankItems,
  readRecent,
  recentItems,
  recordRecent,
  repoItems,
  scoreItem,
  settingItems,
  symbolItems,
} from './palette.ts'
import { settingsIndex } from './settings-search.ts'
import { settingsSectionIds } from './settings-sections.ts'

const repo = (
  path: string,
  groups: string[] = ['web'],
  health: RepoSummary['health'] = 'not-analysed',
  cells: RepoSummary['cells'] = {},
): RepoSummary => ({
  repo: { forge: 'gitlab', path },
  groups,
  health,
  cells,
})

const repos = [
  repo('acme/checkout-web', ['web'], 'failing', {
    security: { value: '1 high', sub: '', tone: 'warn' },
    jobs: { value: '3 failed', sub: '', tone: 'bad' },
    release: { value: 'Ready', sub: '', tone: 'ok' },
  }),
  repo('acme/ledger-api', ['payments'], 'healthy', { jobs: { value: 'OK', sub: '', tone: 'ok' } }),
  repo('acme/widget'),
]

const item = (id: string, title: string, extra: Partial<PaletteItem> = {}): PaletteItem => ({
  id,
  kind: 'pages',
  title,
  link: { to: '/' },
  ...extra,
})

test('prefixes pick a kind', () => {
  expect(parseQuery('  > theme')).toEqual({ text: 'theme', kind: 'actions' })
  expect(parseQuery('#check')).toEqual({ text: 'check', kind: 'repos' })
  expect(parseQuery('@mira')).toEqual({ text: 'mira', kind: 'people' })
  expect(parseQuery(' widget ')).toEqual({ text: 'widget' })
})

test('scores prefer title prefix, then word start, then substring, then other fields', () => {
  const entry = item('a', 'acme/checkout-web', { subtitle: 'Payments team' })
  expect(scoreItem(entry, 'acme')).toBe(0)
  expect(scoreItem(entry, 'check')).toBe(1)
  expect(scoreItem(entry, 'kout')).toBe(2)
  expect(scoreItem(entry, 'payments')).toBe(3)
  expect(scoreItem(entry, 'nothing')).toBeUndefined()
  expect(scoreItem(entry, '')).toBe(0)
})

test('ranking keeps source order on ties and drops misses', () => {
  const items = [
    item('1', 'Widget list'),
    item('2', 'Big widget'),
    item('3', 'Widgets'),
    item('4', 'Other'),
  ]
  expect(rankItems(items, 'widget').map((each) => each.id)).toEqual(['1', '3', '2'])
})

test('highlight splits around the first match, ignoring case', () => {
  expect(highlight('acme/checkout-web', 'CHECK')).toEqual({
    pre: 'acme/',
    hit: 'check',
    post: 'out-web',
  })
  expect(highlight('Widget', 'zzz')).toEqual({ pre: 'Widget', hit: '', post: '' })
})

test('repositories carry their health and the cells that need attention', () => {
  const [checkout, ledger, widget] = repoItems(repos)
  expect(checkout).toMatchObject({
    id: 'repos:gitlab:acme/checkout-web',
    title: 'acme/checkout-web',
    tone: 'danger',
    meta: 'Failing',
    subtitle: 'web · Failing · Jobs 3 failed · Security 1 high',
    link: { to: '/repos/$', params: { _splat: 'gitlab/acme/checkout-web' } },
  })
  expect(Object.keys(checkout?.repo?.cells ?? {})).toHaveLength(3)
  expect(ledger).toMatchObject({ tone: 'ok', meta: 'Healthy' })
  expect(widget).toMatchObject({ tone: 'none', meta: 'Not analysed' })
  expect(rankItems(repoItems(repos), 'payments').map((each) => each.title)).toEqual([
    'acme/ledger-api',
  ])
})

test('libraries and symbols link to their pages', () => {
  const library = {
    ecosystem: 'npm',
    name: 'some-lib',
    internal: false,
    usedBy: 1,
    latest: '2.0.0',
  } satisfies DependencySearchHit
  expect(libraryItems([library])[0]).toMatchObject({
    title: 'some-lib',
    meta: '2.0.0',
    subtitle: 'Library · npm · used in 1 repository',
    link: {
      to: '/supply/libraries/$ecosystem/$',
      params: { ecosystem: 'npm', _splat: 'some-lib' },
    },
  })
  const hit = {
    package: '@acme/foo-util',
    version: '2.3.0',
    repo: { forge: 'gitlab', path: 'acme/foo-util' },
    subpath: '.',
    importPath: '@acme/foo-util',
    symbol: { name: 'checkRange', kind: 'function' },
  } as PublicApiSymbolHit
  expect(symbolItems([hit])[0]).toMatchObject({
    title: 'checkRange',
    subtitle: 'function · @acme/foo-util 2.3.0',
    link: {
      to: '/supply/public-api',
      search: {
        tab: 'search',
        q: 'checkRange',
        symbol: '@acme/foo-util:checkRange',
        repo: 'gitlab:acme/foo-util',
        version: '2.3.0',
      },
    },
  })
})

test('pages read Workspace › Page, single-page workspaces just their name', () => {
  const items = pageItems([
    { workspace: { label: 'Home' }, items: [{ label: 'Home', key: '/', link: { to: '/' } }] },
    {
      workspace: { label: 'Supply', title: 'Supply chain' },
      items: [{ label: 'Security', key: '/supply/security', link: { to: '/supply/security' } }],
    },
  ])
  expect(items.map((each) => each.title)).toEqual(['Home', 'Supply chain › Security'])
})

test('settings come from the shared settings index', () => {
  const definitions: SettingDefinitionView[] = [
    {
      key: 'llm.budget',
      label: 'AI budget',
      description: 'Weekly cap',
      section: 'AI',
      secret: false,
      default: null,
      schema: {},
    },
  ]
  const items = settingItems(settingsIndex(definitions, settingsSectionIds))
  const [budget] = rankItems(items, 'llm.budget')
  expect(budget).toMatchObject({
    id: 'settings:setting:llm.budget',
    title: 'AI budget',
    link: { to: '/settings/$section', params: { section: 'ai' } },
  })
  expect(rankItems(items, 'audit log')[0]?.title).toBe('Settings › Audit log')
})

test('people open their sheet on Settings › People', () => {
  const user = { id: 'u1', name: 'Mira K.', email: 'mira@acme.test', disabled: false } as UserView
  expect(peopleItems([user])[0]).toMatchObject({
    title: 'Mira K.',
    subtitle: 'mira@acme.test',
    link: { to: '/settings/$section', params: { section: 'people' }, search: { item: 'u1' } },
  })
})

const ids = (options: Parameters<typeof actionItems>[0]) =>
  actionItems(options).map((each) => each.action)

test('actions depend on the session', () => {
  expect(ids({ theme: 'dark', signOut: true, chat: true })).toEqual([
    'theme',
    'docs',
    'new-thread',
    'sign-out',
  ])
  expect(ids({ theme: 'light', signOut: false, chat: false })).toEqual(['theme', 'docs'])
  expect(actionItems({ theme: 'light', signOut: false, chat: false })[0]?.title).toBe(
    'Switch to dark theme',
  )
})

test('results group, limit and count per kind', () => {
  const many = Array.from({ length: 8 }, (_, index) =>
    item(`repos:${index}`, `acme/widget-${index}`, { kind: 'repos' }),
  )
  const sources = {
    repos: many,
    pages: [item('pages:/', 'Home')],
    actions: actionItems({ theme: 'dark', signOut: true, chat: false }),
  }
  const all = buildResults(sources, 'widget', 'all')
  expect(all.groups.map((group) => group.kind)).toEqual(['repos'])
  expect(all.groups[0]).toMatchObject({ label: 'Repositories', total: 8 })
  expect(all.groups[0]?.items).toHaveLength(5)
  expect(all.counts.repos).toBe(8)
  expect(all.flat).toHaveLength(5)

  const only = buildResults(sources, 'widget', 'repos')
  expect(only.flat).toHaveLength(8)
  expect(buildResults(sources, 'widget', 'pages').flat).toHaveLength(0)
})

test('an empty query shows recent first, then pages and actions', () => {
  const sources = {
    repos: [item('repos:1', 'acme/widget', { kind: 'repos' })],
    pages: [item('pages:/', 'Home')],
    actions: actionItems({ theme: 'dark', signOut: false, chat: false }),
    recent: [item('repos:1', 'acme/widget', { kind: 'repos' })],
  }
  expect(buildResults(sources, '', 'all').groups.map((group) => group.kind)).toEqual([
    'recent',
    'pages',
    'actions',
  ])
})

test('recent items already shown in their group are not repeated', () => {
  const widget = item('repos:1', 'acme/widget', { kind: 'repos' })
  const other = item('repos:2', 'acme/widget-old', { kind: 'repos' })
  const results = buildResults({ repos: [widget], recent: [widget, other] }, 'widget', 'all')
  expect(results.groups.map((group) => group.kind)).toEqual(['repos', 'recent'])
  expect(results.groups[1]?.items.map((each) => each.id)).toEqual(['repos:2'])
  expect(buildResults({ recent: [widget] }, 'widget', 'recent').flat).toHaveLength(1)
})

test('selection wraps around', () => {
  expect(moveSelection(0, -1, 3)).toBe(2)
  expect(moveSelection(2, 1, 3)).toBe(0)
  expect(moveSelection(1, 1, 3)).toBe(2)
  expect(moveSelection(0, 1, 0)).toBe(-1)
})

test('⌘K and Ctrl+K open the palette, other chords do not', () => {
  expect(isPaletteShortcut({ key: 'k', metaKey: true })).toBe(true)
  expect(isPaletteShortcut({ key: 'K', ctrlKey: true })).toBe(true)
  expect(isPaletteShortcut({ key: 'k' })).toBe(false)
  expect(isPaletteShortcut({ key: 'k', metaKey: true, shiftKey: true })).toBe(false)
  expect(isPaletteShortcut({ key: 'k', ctrlKey: true, altKey: true })).toBe(false)
  expect(isPaletteShortcut({ key: 'j', metaKey: true })).toBe(false)
})

const memory = (): RecentStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return {
    data,
    get length() {
      return data.size
    },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  }
}

test('recent items are deduplicated, newest first and capped', () => {
  const storage = memory()
  const at = new Date('2026-01-01T10:00:00Z')
  for (let index = 0; index < 10; index++)
    recordRecent(storage, 'jane', item(`pages:${index}`, `Page ${index}`), at)
  recordRecent(storage, 'jane', item('pages:3', 'Page 3'), at)
  const recent = readRecent(storage, 'jane')
  expect(recent).toHaveLength(8)
  expect(recent.map((entry) => entry.id).slice(0, 3)).toEqual(['pages:3', 'pages:9', 'pages:8'])
  const pages = Array.from({ length: 10 }, (_, index) => item(`pages:${index}`, `Page ${index}`))
  expect(recentItems(recent, () => '5m', { pages }, false)[0]).toMatchObject({
    id: 'pages:3',
    meta: '5m',
    link: { to: '/' },
  })
})

test('actions are not recorded', () => {
  const storage = memory()
  recordRecent(storage, 'jane', actionItems({ theme: 'dark', signOut: true, chat: true })[0]!)
  expect(readRecent(storage, 'jane')).toEqual([])
})

test('recent items work without storage and when storage throws', () => {
  const broken: RecentStorage = {
    length: 0,
    key: () => null,
    removeItem: () => {
      throw new Error('denied')
    },
    getItem: () => {
      throw new Error('denied')
    },
    setItem: () => {
      throw new Error('denied')
    },
  }
  expect(readRecent(broken, 'jane')).toEqual([])
  expect(recordRecent(broken, 'jane', item('pages:1', 'Page'))).toHaveLength(1)
  expect(readRecent(undefined, 'jane')).toEqual([])
  expect(recordRecent(undefined, 'jane', item('pages:1', 'Page'))).toHaveLength(1)
  expect(() => clearRecent(broken)).not.toThrow()
})

test('unexpected stored values are ignored', () => {
  const storage = memory()
  storage.data.set('holtkeeper.palette.recent:jane', '{"not":"a list"}')
  expect(readRecent(storage, 'jane')).toEqual([])
  storage.data.set(
    'holtkeeper.palette.recent:jane',
    JSON.stringify([
      { id: 'x', kind: 'pages', title: 'X', openedAt: 'now', link: { to: 'https://acme.test' } },
      { id: 'y', kind: 'nope', title: 'Y', openedAt: 'now', link: { to: '/' } },
      { id: 'z', kind: 'pages', title: 'Z', openedAt: 'now', link: { to: '/' } },
    ]),
  )
  expect(readRecent(storage, 'jane').map((entry) => entry.id)).toEqual(['z'])
  storage.data.set('holtkeeper.palette.recent:jane', 'not json')
  expect(readRecent(storage, 'jane')).toEqual([])
})

test('recent items belong to one principal and sign-out forgets them', () => {
  const storage = memory()
  recordRecent(storage, 'jane', item('repos:work:acme/widget', 'acme/widget'))
  expect(readRecent(storage, 'jane')).toHaveLength(1)
  expect(readRecent(storage, 'bob')).toEqual([])
  storage.setItem('holtkeeper.theme', 'dark')
  clearRecent(storage)
  expect(readRecent(storage, 'jane')).toEqual([])
  expect(storage.getItem('holtkeeper.theme')).toBe('dark')
})

const opened = (id: string, kind: RecentItem['kind'] = 'repos'): RecentItem => ({
  id,
  kind,
  title: id,
  link: { to: '/' },
  openedAt: 'now',
})

test('recent items the viewer can no longer reach are left out', () => {
  const recent = [
    opened('repos:work:acme/widget'),
    opened('repos:work:other/gear'),
    opened('libraries:npm:some-lib', 'libraries'),
  ]
  const reachable = [item('repos:work:acme/widget', 'acme/widget')]
  expect(
    recentItems(recent, () => '', { repos: reachable }, false).map((entry) => entry.id),
  ).toEqual(['repos:work:acme/widget'])
  expect(recentItems(recent, () => '', {}, true).map((entry) => entry.id)).toEqual([
    'libraries:npm:some-lib',
  ])
})
