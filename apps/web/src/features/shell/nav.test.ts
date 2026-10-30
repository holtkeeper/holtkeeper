import { expect, test } from 'bun:test'

import { groupNav, visibleNav } from './nav.ts'

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
    'Dependencies',
    'Bundles',
    'Assets',
    'Public API',
    'Releases',
    'Branches',
    'CI jobs',
    'Jobs',
  ])
})

test('groups visible items under their headings and drops empty ones', () => {
  const groups = groupNav(visibleNav(principal, { provider: 'users', methods: [] }))
  expect(groups.map((g) => [g.section, g.items.map((i) => i.label)])).toEqual([
    ['Overview', ['Dashboard', 'Activity']],
    ['Security', ['Audits']],
    ['Admin', ['Users']],
  ])
})
