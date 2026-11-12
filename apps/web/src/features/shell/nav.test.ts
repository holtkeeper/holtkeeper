import { expect, test } from 'bun:test'

import type { Action, Principal, Scope } from '@holtkeeper/api'

import { visibleSettingsSections } from '../../lib/access.ts'
import { settingItems } from '../../lib/palette.ts'
import { settingsIndex } from '../../lib/settings-search.ts'
import {
  activeNav,
  groupByWorkspace,
  navBadgeWord,
  navKey,
  navLink,
  paletteNav,
  visibleNav,
} from './nav.ts'

const principal = {
  id: 'a',
  name: 'A',
  provider: 'users',
  grants: [
    { scope: { repos: ['w:x/**'] }, actions: ['audits:read' as const, 'users:read' as const] },
  ],
}

const withGrant = (scope: Scope, ...actions: (Action | '*')[]) => ({
  ...principal,
  grants: [{ scope, actions }],
})

const workspaceOf = (p: Principal, id: string, crossTeam: 'off' | 'snippets' = 'snippets') =>
  groupByWorkspace(visibleNav(p, crossTeam)).find((g) => g.workspace.id === id)

test('the rail holds the eight workspaces in order, with Settings at the bottom', () => {
  const everything = withGrant({ all: true }, '*')
  const groups = groupByWorkspace(visibleNav(everything, 'snippets'))
  expect(groups.map((g) => [g.workspace.label, g.workspace.bottom === true])).toEqual([
    ['Home', false],
    ['Repos', false],
    ['Chat', false],
    ['Supply', false],
    ['Quality', false],
    ['Releases', false],
    ['Knowledge', false],
    ['Ops', false],
    ['Settings', true],
  ])
  expect(groups.map((g) => [g.workspace.id, g.items.map(navKey)])).toEqual([
    ['home', ['/', '/inbox']],
    ['repos', ['/repos', '/repos/groups']],
    ['chat', ['/chat']],
    [
      'supply',
      [
        '/supply/libraries',
        '/supply/security',
        '/supply/licenses',
        '/supply/stack',
        '/supply/public-api',
      ],
    ],
    [
      'quality',
      [
        '/quality/coverage',
        '/quality/bundles',
        '/quality/assets',
        '/quality/ci',
        '/quality/branches',
        '/quality/reviews',
      ],
    ],
    ['releases', ['/releases', '/releases/timeline', '/releases/setup']],
    ['knowledge', ['/knowledge/guide', '/knowledge/notes', '/knowledge/learnings']],
    ['ops', ['/ops/runs', '/ops/tasks', '/ops/automation', '/ops/spend']],
    [
      'settings',
      [
        '/settings/people',
        '/settings/ai',
        '/settings/integrations',
        '/settings/analyzers',
        '/settings/policies',
        '/settings/system',
        '/settings/audit',
      ],
    ],
  ])
})

test('hides entries the principal cannot use', () => {
  expect(visibleNav(principal, 'snippets').map((i) => i.label)).toEqual([
    'Overview',
    'Inbox',
    'Security',
    'People & access',
  ])
  expect(
    groupByWorkspace(visibleNav(principal, 'snippets')).map((g) => [
      g.workspace.id,
      g.items.map((i) => i.label),
    ]),
  ).toEqual([
    ['home', ['Overview', 'Inbox']],
    ['supply', ['Security']],
    ['settings', ['People & access']],
  ])
  const analyst = withGrant({ all: true }, 'analyses:read')
  expect(visibleNav(analyst, 'snippets').map((i) => i.label)).toEqual([
    'Overview',
    'Inbox',
    'Libraries',
    'Licenses',
    'Stack',
    'Public API',
    'Coverage',
    'Bundles',
    'Assets',
    'CI',
    'Branches',
    'Reviews',
    'Runs',
  ])
})

test('entries the server checks globally need a grant over everything', () => {
  const scoped = withGrant({ groups: ['games'] }, 'settings:read')
  const labels = visibleNav(scoped, 'snippets').map((i) => i.label)
  expect(labels).toEqual(expect.arrayContaining(['AI', 'Integrations']))
  for (const label of ['Automation', 'System']) expect(labels).not.toContain(label)
  const admin = withGrant({ all: true }, 'settings:read')
  expect(workspaceOf(admin, 'ops')?.items.map((i) => i.label)).toEqual(['Automation'])
  expect(visibleNav(admin, 'snippets').map((i) => i.label)).toContain('System')
})

const sections = (p: Principal) => workspaceOf(p, 'settings', 'off')?.items.map((i) => i.section)

test('Settings sections follow what the server lets the principal read', () => {
  expect(sections(principal)).toEqual(['people'])
  expect(sections(withGrant({ groups: ['shapes'] }, 'ai:admin'))).toBeUndefined()
  expect(sections(withGrant({ repos: ['w:x/*'] }, 'credentials:read'))).toEqual([
    'ai',
    'integrations',
  ])
  expect(sections(withGrant({ all: true }, 'settings:read'))).toEqual([
    'people',
    'ai',
    'integrations',
    'analyzers',
    'policies',
    'system',
  ])
  expect(sections(withGrant({ all: true }, 'audit:read'))).toEqual(['audit'])
})

test('Analyzers and Policies open for settings:read on any scope, each with its own icon', () => {
  const scoped = workspaceOf(withGrant({ groups: ['shapes'] }, 'settings:read'), 'settings', 'off')
  const entries = scoped?.items.filter(
    (item) => item.section === 'analyzers' || item.section === 'policies',
  )
  expect(entries?.map((item) => [navKey(item), item.label, item.brand])).toEqual([
    ['/settings/analyzers', 'Analyzers', 'jobs'],
    ['/settings/policies', 'Policies', 'audit'],
  ])
  const items = scoped?.items ?? []
  expect(new Set(items.map((item) => item.icon)).size).toBe(items.length)
  expect(activeNav('/settings/policies')?.label).toBe('Policies')
})

test('AI spend sits under Ops for ai:read or ai:admin', () => {
  for (const action of ['ai:read', 'ai:admin'] as const)
    expect(
      workspaceOf(withGrant({ groups: ['shapes'] }, action), 'ops')?.items.map(navKey),
    ).toEqual(['/ops/spend'])
  expect(visibleNav(withGrant({ all: true }, 'settings:read'), 'off').map(navKey)).not.toContain(
    '/ops/spend',
  )
})

test('repository readers see Repos, Chat, Tasks under Ops and Settings with only the Audit log', () => {
  const reader = withGrant({ groups: ['shop'] }, 'repos:read')
  expect(visibleNav(reader, 'off').map(navKey)).toEqual([
    '/',
    '/inbox',
    '/repos',
    '/repos/groups',
    '/chat',
    '/ops/tasks',
    '/settings/audit',
  ])
  expect(workspaceOf(reader, 'settings', 'off')?.items.map((i) => i.label)).toEqual(['Audit log'])
  expect(visibleNav(principal, 'snippets').map((i) => i.label)).not.toContain('Chat')
})

test('the Inbox and Tasks tabs carry badges, nothing else does', () => {
  const everything = visibleNav(withGrant({ all: true }, '*'), 'snippets')
  expect(everything.filter((item) => item.badge).map((item) => [navKey(item), item.badge])).toEqual(
    [
      ['/inbox', 'inbox'],
      ['/ops/tasks', 'tasks'],
    ],
  )
  expect(navBadgeWord.tasks).toBe('need approval')
})

test('catalog pages follow catalog reach and the cross-team level', () => {
  const catalogPages = ['Libraries', 'Stack', 'Public API']
  const reader = withGrant({ groups: ['games'] }, 'repos:read')
  expect(visibleNav(reader, 'metadata').map((i) => i.label)).toEqual(
    expect.arrayContaining(catalogPages),
  )
  const closed = visibleNav(reader, 'off').map((i) => i.label)
  for (const label of catalogPages) expect(closed).not.toContain(label)
  expect(
    visibleNav(withGrant({ groups: ['games'] }, 'catalog:read'), 'off').map((i) => i.label),
  ).toEqual(expect.arrayContaining(catalogPages))
})

test('the active entry is the longest path prefix', () => {
  expect(activeNav('/')?.label).toBe('Overview')
  expect(activeNav('/inbox')?.label).toBe('Inbox')
  expect(activeNav('/inbox')?.workspace).toBe('home')
  expect(activeNav('/inboxes')).toBeUndefined()
  expect(activeNav('/repos/work/acme/widget-kit')?.label).toBe('Repositories')
  expect(activeNav('/repos/groups')?.label).toBe('Groups')
  expect(activeNav('/repos/groups/g1')?.label).toBe('Groups')
  expect(activeNav('/repos/groups/g1')?.workspace).toBe('repos')
  expect(activeNav('/chat')?.label).toBe('Chat')
  expect(activeNav('/supply/libraries/npm/@scope/widget')?.label).toBe('Libraries')
  expect(activeNav('/supply/security/runs/r1')?.label).toBe('Security')
  expect(activeNav('/quality/ci')?.label).toBe('CI')
  expect(activeNav('/quality/assets')?.label).toBe('Assets')
  expect(activeNav('/quality/reviews')?.label).toBe('Reviews')
  expect(activeNav('/releases')?.label).toBe('Overview')
  expect(activeNav('/releases')?.workspace).toBe('releases')
  expect(activeNav('/releases/timeline')?.label).toBe('Timeline')
  expect(activeNav('/releases/setup')?.label).toBe('Flow setup')
  expect(activeNav('/releases/setup')?.workspace).toBe('releases')
  expect(activeNav('/releases/timeline/')?.label).toBe('Timeline')
  expect(activeNav('/knowledge/notes')?.label).toBe('Notes')
  expect(activeNav('/ops/runs/j1')?.label).toBe('Runs')
  expect(activeNav('/ops/spend')?.label).toBe('AI spend')
  expect(activeNav('/ops/history')).toBeUndefined()
  expect(activeNav('/ops/automationx')).toBeUndefined()
  expect(activeNav('/supply')).toBeUndefined()
  expect(activeNav('/account/profile')).toBeUndefined()
  for (const old of ['/jobs', '/audits', '/dependencies', '/knowledge', '/ci', '/history'])
    expect(activeNav(old)).toBeUndefined()
})

test('Settings entries are told apart by their section in the path', () => {
  expect(activeNav('/settings/ai')?.label).toBe('AI')
  expect(activeNav('/settings/system')?.label).toBe('System')
  expect(activeNav('/settings/audit')?.label).toBe('Audit log')
  expect(activeNav('/settings')).toBeUndefined()
  expect(activeNav('/settings/access')).toBeUndefined()
  const visible = visibleNav(principal, 'snippets')
  expect(activeNav('/settings/people', undefined, visible)?.label).toBe('People & access')
  expect(activeNav('/settings/system', undefined, visible)).toBeUndefined()
})

test('links open the entry, with the section as a route parameter', () => {
  const everything = visibleNav(withGrant({ all: true }, '*'), 'snippets')
  expect(navLink(everything.find((i) => i.section === 'audit')!)).toEqual({
    to: '/settings/$section',
    params: { section: 'audit' },
  })
  expect(navLink(everything.find((i) => i.label === 'Runs')!)).toEqual({ to: '/ops/runs' })
})

test('an analysis record belongs to the page of its kind, else to Repositories', () => {
  expect(activeNav('/analyses/a1')).toBeUndefined()
  expect(activeNav('/analyses/a1', 'bundle')?.to).toBe('/quality/bundles')
  expect(activeNav('/analyses/a1', 'depgraph')?.label).toBe('Libraries')
  expect(activeNav('/analyses/a1', 'stack')?.to).toBe('/supply/stack')
  expect(activeNav('/analyses/a1', 'ci-jobs')?.workspace).toBe('quality')
  expect(activeNav('/analyses/a1', 'assets')?.to).toBe('/quality/assets')
  expect(activeNav('/analyses/a1', 'review')?.to).toBe('/quality/reviews')
  expect(activeNav('/analyses/a1', 'renovate')?.label).toBe('Repositories')
})

test('the palette lists each Settings section once, from the settings index', () => {
  const everything = withGrant({ all: true }, '*')
  const pages = paletteNav(visibleNav(everything, 'snippets')).map((item) =>
    JSON.stringify(navLink(item)),
  )
  const settings = settingItems(settingsIndex([], visibleSettingsSections(everything))).map(
    (item) => JSON.stringify(item.link),
  )
  const links = [...pages, ...settings]
  expect(settings.length).toBeGreaterThan(0)
  expect(new Set(links).size).toBe(links.length)
})
