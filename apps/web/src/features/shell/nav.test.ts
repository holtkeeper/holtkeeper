import { expect, test } from 'bun:test'

import { activeNav, groupNav, visibleNav } from './nav.ts'

const principal = {
  id: 'a',
  name: 'A',
  provider: 'users',
  grants: [
    { scope: { repos: ['w:x/**'] }, actions: ['audits:read' as const, 'users:read' as const] },
  ],
}

test('hides items the principal cannot use and Users outside the users provider', () => {
  expect(visibleNav(principal, { provider: 'users', methods: [] }).map((i) => i.label)).toEqual([
    'Dashboard',
    'Activity',
    'Audits',
    'MCP server',
    'Users',
  ])
  expect(
    visibleNav(principal, { provider: 'none', methods: [] }).map((i) => i.label),
  ).not.toContain('Users')
  const analyst = {
    ...principal,
    grants: [{ scope: { all: true }, actions: ['analyses:read' as const] }],
  }
  expect(visibleNav(analyst, { provider: 'none', methods: [] }).map((i) => i.label)).toEqual([
    'Fleet',
    'Tech stack',
    'Activity',
    'Licenses',
    'Code quality',
    'Test coverage',
    'Test ids',
    'Bundles',
    'Assets',
    'Dependencies',
    'Dependency updates',
    'Public API',
    'Releases',
    'Branches',
    'CI jobs',
    'Build warm-up',
    'Jobs',
    'MCP server',
    'Libraries',
  ])
})

test('groups visible items under their headings and drops empty ones', () => {
  const groups = groupNav(visibleNav(principal, { provider: 'users', methods: [] }))
  expect(groups.map((g) => [g.section, g.items.map((i) => i.label)])).toEqual([
    ['Overview', ['Dashboard', 'Activity']],
    ['Security', ['Audits']],
    ['MCP', ['MCP server']],
    ['Admin', ['Users']],
  ])
})

test('finds the entry of a page, its sub-pages and analysis records by kind', () => {
  expect(activeNav('/')?.label).toBe('Dashboard')
  expect(activeNav('/testids')?.label).toBe('Test ids')
  expect(activeNav('/repos/groups/g1')?.label).toBe('Repositories')
  expect(activeNav('/audit-log')?.label).toBe('Audit log')
  expect(activeNav('/libraries/view')?.label).toBe('Libraries')
  expect(activeNav('/mcp-server')?.label).toBe('MCP server')
  expect(activeNav('/audits/r1')?.label).toBe('Audits')
  expect(activeNav('/analyses/a1', 'testids')?.label).toBe('Test ids')
  expect(activeNav('/analyses/a1', 'depgraph')?.label).toBe('Dependencies')
  expect(activeNav('/analyses/a1', 'stack')?.label).toBe('Tech stack')
  expect(activeNav('/analyses/a1', 'renovate')?.label).toBe('Dependency updates')
  expect(activeNav('/analyses/a1')).toBeUndefined()
  expect(activeNav('/account')).toBeUndefined()
})
