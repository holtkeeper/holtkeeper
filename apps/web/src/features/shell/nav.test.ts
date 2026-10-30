import { expect, test } from 'bun:test'

import { visibleNav } from './nav.ts'

test('hides items the principal cannot use and Users outside the users provider', () => {
  const principal = {
    id: 'a',
    name: 'A',
    provider: 'users',
    grants: [
      { scope: { repos: ['w:x/**'] }, actions: ['audits:read' as const, 'users:read' as const] },
    ],
  }
  expect(visibleNav(principal, { provider: 'users', methods: [] }).map((i) => i.label)).toEqual([
    'Dashboard',
    'Audits',
    'Users',
    'Activity',
  ])
  expect(
    visibleNav(principal, { provider: 'none', methods: [] }).map((i) => i.label),
  ).not.toContain('Users')
  const analyst = {
    ...principal,
    grants: [{ scope: { all: true }, actions: ['analyses:read' as const] }],
  }
  expect(visibleNav(analyst, { provider: 'none', methods: [] }).map((i) => i.label)).toEqual([
    'Releases',
    'Bundles',
    'Dependencies',
    'Code quality',
    'Test coverage',
    'Test ids',
    'Branches',
    'CI jobs',
    'Licenses',
    'Jobs',
    'Activity',
  ])
})
