import { describe, expect, test } from 'bun:test'

import type { Grant, UserView } from '@holtkeeper/api'

import { accessMap, describeActions, withGrant, withoutGrant } from './access-map.ts'

const user = (id: string, grants: Grant[]): UserView => ({
  id,
  name: id.toUpperCase(),
  grants,
  disabled: false,
  createdAt: '2026-10-01T00:00:00Z',
  passkeys: [],
  identities: [],
  avatarUrl: `/api/avatars/${id}.svg`,
})

describe('access map', () => {
  test('links users to the scopes of their grants, merging grants per scope', () => {
    const map = accessMap(
      [
        user('ada', [{ scope: { all: true }, actions: ['*'] }]),
        user('bob', [
          { scope: { teams: ['games'] }, actions: ['repos:read'] },
          { scope: { teams: ['games'] }, actions: ['audits:read', 'repos:read'] },
          { scope: { repos: ['work:games/**'] }, actions: ['audits:run'] },
        ]),
      ],
      ['games', 'tools'],
    )
    expect(map.scopes.map((s) => [s.id, s.idle])).toEqual([
      ['scope:everything', false],
      ['scope:team games', false],
      ['scope:team tools', true],
      ['scope:work:games/**', false],
    ])
    expect(map.edges).toEqual([
      { from: 'user:ada', to: 'scope:everything', actions: ['*'], label: 'all actions' },
      {
        from: 'user:bob',
        to: 'scope:team games',
        actions: ['repos:read', 'audits:read'],
        label: 'read only',
      },
      { from: 'user:bob', to: 'scope:work:games/**', actions: ['audits:run'], label: '1 action' },
    ])
    expect(map.users.map((u) => u.id)).toEqual(['user:ada', 'user:bob'])
  })

  test('action summaries', () => {
    expect(describeActions([])).toBe('0 actions')
    expect(describeActions(['settings:read', 'settings:write'])).toBe('2 actions')
  })
})

describe('editing grants', () => {
  const grants: Grant[] = [{ scope: { teams: ['games'] }, actions: ['*'] }]

  test('linking adds a read-only grant once', () => {
    expect(withGrant(grants, { teams: ['tools'] })).toEqual([
      ...grants,
      { scope: { teams: ['tools'] }, actions: ['repos:read', 'audits:read'] },
    ])
    expect(withGrant(grants, { teams: ['games'] })).toEqual(grants)
  })

  test('unlinking drops every grant on the scope', () => {
    expect(
      withoutGrant(
        [...grants, { scope: { all: true }, actions: ['repos:read'] }],
        'scope:team games',
      ),
    ).toEqual([{ scope: { all: true }, actions: ['repos:read'] }])
  })
})
