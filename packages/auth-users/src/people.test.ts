import { describe, expect, test } from 'bun:test'

import type { User } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'

import { inviteOf, peopleSummary, rememberInvite, teamsOf, touchLastSeen } from './people.ts'

const user = (patch: Partial<User> = {}): User => ({
  id: 'u1',
  name: 'Widget Dev',
  grants: [
    { scope: { teams: ['widgets', 'gizmo'] }, actions: ['repos:read'] },
    { scope: { teams: ['widgets'] }, actions: ['analyses:run'] },
  ],
  disabled: false,
  sessionVersion: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  ...patch,
})

const now = () => new Date('2026-10-29T12:00:00.000Z')

const teams = () => ({
  gadgets: { owns: ['acme/round/**'], members: [{ id: 'u1', role: 'member' as const }] },
  gizmo: { owns: ['acme/square/**'], members: [{ id: 'u2', role: 'member' as const }] },
})

describe('people views', () => {
  test('teams come from the grants without a kv store', async () => {
    const store = memoryStore()
    expect(await teamsOf({ store: store.users, now }, user())).toEqual(['widgets', 'gizmo'])
  })

  test('teams the user is a member of come first', async () => {
    const store = memoryStore()
    expect(await teamsOf({ store: store.users, teams, now }, user())).toEqual([
      'gadgets',
      'widgets',
      'gizmo',
    ])
  })

  test('invites need a kv store and a person who never signed in', async () => {
    const store = memoryStore()
    const deps = { store: store.users, kv: store.kv, now }
    await rememberInvite(deps, 'u1', {
      createdAt: '2026-10-28T12:00:00.000Z',
      expiresAt: '2026-10-29T12:00:00.000Z',
    })
    expect(await inviteOf(deps, user(), false)).toEqual({
      createdAt: '2026-10-28T12:00:00.000Z',
      expiresAt: '2026-10-29T12:00:00.000Z',
      expired: true,
    })
    expect(await inviteOf(deps, user(), true)).toBeUndefined()
    expect(await inviteOf({ store: store.users, now }, user(), false)).toBeUndefined()
  })

  test('a failing lastSeenAt write is swallowed', async () => {
    const store = memoryStore()
    const failing = {
      ...store.users,
      touchUser: async () => {
        throw new Error('read-only replica')
      },
    }
    expect(await touchLastSeen({ store: failing, now }, user())).toBeUndefined()
  })

  test('an admin grant next to other grants still counts as an admin', async () => {
    const store = memoryStore()
    const mixed = user({
      grants: [
        { scope: { all: true }, actions: ['*'] },
        { scope: { teams: ['widgets'] }, actions: ['repos:read'] },
      ],
    })
    const summary = await peopleSummary(
      { store: store.users, now },
      [mixed, user({ id: 'u2' })],
      [],
    )
    expect(summary.admins).toBe(1)
  })
})
