import { expect, test } from 'bun:test'

import { activeNav, groupByWorkspace, navKey, visibleNav, visibleSettingsTabs } from './nav.ts'

const principal = {
  id: 'a',
  name: 'A',
  provider: 'users',
  grants: [
    { scope: { repos: ['w:x/**'] }, actions: ['audits:read' as const, 'users:read' as const] },
  ],
}

test('hides items the principal cannot use; everyone reaches Access for their MCP tokens', () => {
  expect(visibleNav(principal, 'snippets').map((i) => i.label)).toEqual([
    'Home',
    'Audits',
    'Access',
  ])
  const analyst = {
    ...principal,
    grants: [{ scope: { all: true }, actions: ['analyses:read' as const] }],
  }
  const operator = {
    ...principal,
    grants: [{ scope: { all: true }, actions: ['analyses:read' as const, 'repos:read' as const] }],
  }
  expect(
    groupByWorkspace(visibleNav(operator, 'snippets'))
      .find((g) => g.workspace.id === 'ops')
      ?.items.map((i) => i.label),
  ).toEqual(['Jobs', 'Tasks', 'History'])
  expect(visibleNav(analyst, 'snippets').map((i) => i.label)).toEqual([
    'Home',
    'Dependencies',
    'Public API',
    'Stack',
    'Licenses',
    'Bundles',
    'Coverage',
    'Branches',
    'CI',
    'Jobs',
    'Access',
  ])
})

test('entries the server checks globally need a grant over everything', () => {
  const scoped = {
    ...principal,
    grants: [{ scope: { groups: ['games'] }, actions: ['settings:read' as const] }],
  }
  const labels = visibleNav(scoped, 'snippets').map((i) => i.label)
  expect(labels).toEqual(expect.arrayContaining(['AI', 'Access', 'Integrations']))
  for (const label of ['Automation', 'System']) expect(labels).not.toContain(label)
  const admin = {
    ...scoped,
    grants: [{ scope: { all: true }, actions: ['settings:read' as const] }],
  }
  expect(visibleNav(admin, 'snippets').map((i) => i.label)).toEqual(
    expect.arrayContaining(['Automation', 'System']),
  )
})

test('Settings tabs follow what the server lets the principal read', () => {
  expect(visibleSettingsTabs(principal)).toEqual(['access'])
  const aiReader = {
    ...principal,
    grants: [{ scope: { groups: ['shapes'] }, actions: ['ai:admin' as const] }],
  }
  expect(visibleSettingsTabs(aiReader)).toEqual(['ai', 'access'])
  const keeper = {
    ...principal,
    grants: [{ scope: { repos: ['w:x/*'] }, actions: ['credentials:read' as const] }],
  }
  expect(visibleSettingsTabs(keeper)).toEqual(['ai', 'access', 'integrations'])
  const admin = {
    ...principal,
    grants: [{ scope: { all: true }, actions: ['settings:read' as const] }],
  }
  expect(visibleSettingsTabs(admin)).toEqual(['ai', 'access', 'integrations', 'system'])
})

test('groups visible items under their workspaces and drops empty ones', () => {
  const groups = groupByWorkspace(visibleNav(principal, 'snippets'))
  expect(groups.map((g) => [g.workspace.id, g.items.map((i) => i.label)])).toEqual([
    ['home', ['Home']],
    ['code', ['Audits']],
    ['admin', ['Access']],
  ])
})

test('repository readers see Tasks and History under Ops; History replaces Activity and the audit log', () => {
  const reader = {
    ...principal,
    grants: [{ scope: { groups: ['shop'] }, actions: ['repos:read' as const] }],
  }
  const labels = visibleNav(reader, 'off').map((i) => i.label)
  expect(labels).toEqual(['Home', 'Repositories', 'Chat', 'Tasks', 'History', 'Access'])
  expect(activeNav('/activity')).toBeUndefined()
  expect(activeNav('/audit-log')).toBeUndefined()
})

test('settings readers see one Automation page under Ops and Settings as four tabs', () => {
  const admin = {
    ...principal,
    grants: [{ scope: { all: true }, actions: ['settings:read' as const] }],
  }
  const groups = groupByWorkspace(visibleNav(admin, 'snippets'))
  expect(groups.find((g) => g.workspace.id === 'ops')?.items.map((i) => i.label)).toEqual([
    'Automation',
  ])
  expect(groups.find((g) => g.workspace.id === 'admin')?.items.map(navKey)).toEqual([
    '/settings?tab=ai',
    '/settings?tab=access',
    '/settings?tab=integrations',
    '/settings?tab=system',
  ])
})

test('repository and group page tabs stay under Repositories, even a Settings tab', () => {
  for (const tab of ['overview', 'guide', 'assets', 'reviews', 'settings'])
    expect(activeNav('/repos/view', undefined, tab)?.label).toBe('Repositories')
  for (const tab of ['repos', 'guide', 'stack', 'settings'])
    expect(activeNav('/repos/groups/g1', undefined, tab)?.label).toBe('Repositories')
})

test('finds the entry of a page, its sub-pages, page tabs and analysis records by kind', () => {
  expect(activeNav('/analyses/a1', 'assets')?.label).toBe('Repositories')
  expect(activeNav('/analyses/a1', 'review')?.label).toBe('Repositories')
  expect(activeNav('/analyses/a1')).toBeUndefined()
  expect(activeNav('/')?.label).toBe('Home')
  expect(activeNav('/repos/groups/g1')?.label).toBe('Repositories')
  expect(activeNav('/history')?.label).toBe('History')
  expect(activeNav('/history')?.workspace).toBe('ops')
  expect(activeNav('/tasks')?.label).toBe('Tasks')
  expect(activeNav('/tasks')?.workspace).toBe('ops')
  expect(activeNav('/libraries')).toBeUndefined()
  expect(activeNav('/dependencies/npm/@scope/widget')?.label).toBe('Dependencies')
  for (const old of ['/mcp-server', '/ai', '/users', '/credentials', '/storage', '/caches'])
    expect(activeNav(old)).toBeUndefined()
  expect(activeNav('/audits/r1')?.label).toBe('Audits')
  expect(activeNav('/automation')?.label).toBe('Automation')
  expect(activeNav('/automation')?.workspace).toBe('ops')
  expect(activeNav('/settings')?.label).toBe('AI')
  expect(activeNav('/settings', undefined, 'system')?.label).toBe('System')
  expect(activeNav('/settings', undefined, 'integrations')?.label).toBe('Integrations')
  expect(activeNav('/settings', undefined, 'analyzers')?.workspace).toBe('admin')
  expect(activeNav('/analyses/a1', 'testids')?.label).toBe('Repositories')
  expect(activeNav('/analyses/a1', 'depgraph')?.label).toBe('Dependencies')
  expect(activeNav('/analyses/a1', 'stack')?.label).toBe('Stack')
  expect(activeNav('/analyses/a1', 'renovate')?.label).toBe('Repositories')
  expect(activeNav('/analyses/a1')).toBeUndefined()
  expect(activeNav('/account')).toBeUndefined()
})

test('knowledge readers find Knowledge in the Team workspace, with its spaces under one entry', () => {
  const reader = {
    ...principal,
    grants: [{ scope: { groups: ['shapes'] }, actions: ['knowledge:read' as const] }],
  }
  const groups = groupByWorkspace(visibleNav(reader, 'snippets'))
  expect(groups.find((g) => g.workspace.id === 'team')?.items.map((i) => i.label)).toEqual([
    'Knowledge',
  ])
  expect(activeNav('/knowledge')?.label).toBe('Knowledge')
})

test('Releases and CI form the Delivery workspace; a release timeline belongs to Releases', () => {
  const releaser = {
    ...principal,
    grants: [
      { scope: { all: true }, actions: ['releases:read' as const, 'analyses:read' as const] },
    ],
  }
  const groups = groupByWorkspace(visibleNav(releaser, 'snippets'))
  expect(groups.find((g) => g.workspace.id === 'delivery')?.items.map((i) => i.to)).toEqual([
    '/releases',
    '/ci',
  ])
  expect(activeNav('/releases/w:shop/widgets')?.label).toBe('Releases')
  expect(activeNav('/release-board')).toBeUndefined()
})

test('chat needs repos:read somewhere, as the server does, and owns its workspace', () => {
  const reader = {
    ...principal,
    grants: [{ scope: { repos: ['w:x/app'] }, actions: ['repos:read' as const] }],
  }
  const groups = groupByWorkspace(visibleNav(reader, 'snippets'))
  expect(groups.find((g) => g.workspace.id === 'chat')?.items.map((i) => i.label)).toEqual(['Chat'])
  expect(visibleNav(principal, 'snippets').map((i) => i.label)).not.toContain('Chat')
  expect(activeNav('/chat')?.label).toBe('Chat')
})

test('catalog pages follow catalog reach and the cross-team level', () => {
  const reader = {
    ...principal,
    grants: [{ scope: { groups: ['games'] }, actions: ['repos:read' as const] }],
  }
  const catalogPages = ['Dependencies', 'Public API', 'Stack']
  expect(visibleNav(reader, 'metadata').map((i) => i.label)).toEqual(
    expect.arrayContaining(catalogPages),
  )
  const closed = visibleNav(reader, 'off').map((i) => i.label)
  for (const label of catalogPages) expect(closed).not.toContain(label)
  const cataloger = {
    ...principal,
    grants: [{ scope: { groups: ['games'] }, actions: ['catalog:read' as const] }],
  }
  expect(visibleNav(cataloger, 'off').map((i) => i.label)).toEqual(
    expect.arrayContaining(catalogPages),
  )
})

test('Settings highlights the tab the page shows, never one the principal cannot see', () => {
  const visible = visibleNav(principal, 'snippets')
  expect(activeNav('/settings', undefined, undefined, visible)?.label).toBe('Access')
  expect(activeNav('/settings', undefined, 'system', visible)?.label).toBe('Access')
})
