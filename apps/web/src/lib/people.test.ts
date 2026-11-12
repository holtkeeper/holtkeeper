import { describe, expect, test } from 'bun:test'

import type { UserView } from '@holtkeeper/api'

import {
  avatarOf,
  defaultPeopleFilter,
  initialsOf,
  lastSeenLabel,
  matchesPeople,
  personOf,
  reachLevels,
  roleCounts,
  scopeLabel,
  signInLabel,
  statusNote,
  teamOptions,
  userStatusOf,
} from './people.ts'
import { grantsForRole } from './roles.ts'

const now = new Date('2026-11-02T12:00:00.000Z')

const user = (patch: Partial<UserView> = {}): UserView => ({
  id: 'u1',
  name: 'Widget Dev',
  email: 'widget.dev@acme.test',
  grants: grantsForRole('developer', { groups: ['widgets'] }),
  disabled: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  passkeys: [],
  identities: [],
  avatarUrl: '/api/avatars/u1.svg',
  teams: ['widgets'],
  ...patch,
})

const passkey = { id: 'p1', createdAt: '2026-10-01T00:00:00.000Z' }

describe('people', () => {
  test('initials', () => {
    expect(initialsOf('Ann Lee Smith')).toBe('AL')
    expect(initialsOf('kriakiku')).toBe('K')
    expect(initialsOf('  ')).toBe('?')
  })

  test('actor ids resolve to people or fall back to the id', () => {
    const people = { u1: { name: 'Ann', avatarUrl: '/api/avatars/fox.svg' } }
    expect(personOf(people, 'u1')).toEqual({
      name: 'Ann',
      avatarUrl: '/api/avatars/fox.svg',
      known: true,
    })
    expect(personOf(people, 'work:games/a')).toEqual({
      name: 'work:games/a',
      avatarUrl: avatarOf('work:games/a'),
      known: false,
    })
    expect(avatarOf('a b')).toBe('/api/avatars/a%20b.svg')
  })
})

describe('people table', () => {
  test('status, sign-in and the note under the status', () => {
    expect(userStatusOf(user())).toBe('active')
    expect(userStatusOf(user({ disabled: true }))).toBe('disabled')
    const invited = user({
      invite: { expiresAt: '2026-11-04T12:00:00.000Z', expired: false },
    })
    expect(userStatusOf(invited)).toBe('invited')
    expect(statusNote(invited, now)).toBe('Link expires in 2 days')
    expect(
      statusNote(user({ invite: { expiresAt: '2026-11-01T12:00:00.000Z', expired: true } }), now),
    ).toBe('Link expired · send a new one')
    expect(statusNote(user(), now)).toBeUndefined()

    expect(signInLabel(user())).toBe('No passkey yet')
    expect(signInLabel(user({ passkeys: [passkey, { ...passkey, id: 'p2' }] }))).toBe('Passkey · 2')
    expect(signInLabel(user({ identities: [{ provider: 'corp' }] }))).toBe('SSO · corp')
    expect(signInLabel(user({ passkeys: [passkey], identities: [{ provider: 'corp' }] }))).toBe(
      'Passkey and SSO',
    )
    expect(lastSeenLabel(user(), now)).toBe('Never')
    expect(lastSeenLabel(user({ lastSeenAt: '2026-11-02T09:00:00.000Z' }), now)).toBe('3 hours ago')
  })

  test('scope labels', () => {
    expect(scopeLabel({ all: true })).toBe('All repositories')
    expect(scopeLabel({ groups: ['widgets'] })).toBe('Group widgets')
    expect(scopeLabel({ repos: ['acme/widget-kit'] })).toBe('acme/widget-kit')
    expect(scopeLabel({ groups: ['widgets', ['gadgets', 'shapes']], repos: ['acme/*'] })).toBe(
      'widgets, gadgets + shapes +1',
    )
    expect(scopeLabel({})).toBe('Nothing')
  })

  test('filters by query, role, team, sign-in and status', () => {
    const viewer = user({
      id: 'u2',
      name: 'Gadget Viewer',
      grants: grantsForRole('viewer', { groups: ['gadgets'] }),
      teams: ['gadgets'],
      passkeys: [passkey],
    })
    const off = user({ id: 'u3', disabled: true })
    const people = [user(), viewer, off]
    const shown = (patch: Partial<typeof defaultPeopleFilter>) =>
      people.filter((p) => matchesPeople(p, { ...defaultPeopleFilter, ...patch })).map((p) => p.id)
    expect(shown({})).toEqual(['u1', 'u2'])
    expect(shown({ statuses: [] })).toEqual(['u1', 'u2', 'u3'])
    expect(shown({ query: 'GADGET' })).toEqual(['u2'])
    expect(shown({ roles: ['developer'] })).toEqual(['u1'])
    expect(shown({ teams: ['gadgets'] })).toEqual(['u2'])
    expect(shown({ signIn: ['none'] })).toEqual(['u1'])
    expect(teamOptions(people)).toEqual(['gadgets', 'widgets'])
    expect(roleCounts(people)).toMatchObject({ developer: 1, viewer: 1, admin: 0 })
  })
})

test('reach levels cover every crossTeam level, narrowest first', () => {
  expect(reachLevels.map((level) => level.level)).toEqual(['off', 'metadata', 'snippets'])
})
