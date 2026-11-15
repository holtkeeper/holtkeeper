import { describe, expect, test } from 'bun:test'

import { can } from './check.ts'
import { CONSUMER_ACTIONS, teamGrants, teamRoleOf, teamsOfPrincipal, teamsOwning } from './teams.ts'

const teams = {
  gizmo: {
    owns: ['acme/round/**', 'acme/square/**', 'acme/shared/ui-kit'],
    consumes: ['acme/shared/**'],
    members: [
      { id: 'ada', role: 'maintainer' as const },
      { id: 'bob@example.com', role: 'member' as const },
    ],
  },
  kit: {
    owns: ['acme/shared/**'],
    exclude: ['acme/shared/legacy-*'],
    members: [{ id: 'cy', role: 'member' as const }],
  },
}

test('teamsOwning lists every owner, honouring exclusions', () => {
  expect(teamsOwning(teams, 'work', 'acme/shared/ui-kit')).toEqual(['gizmo', 'kit'])
  expect(teamsOwning(teams, 'work', 'acme/round/web')).toEqual(['gizmo'])
  expect(teamsOwning(teams, 'work', 'acme/shared/legacy-x')).toEqual([])
})

describe('membership', () => {
  test('matches ids and e-mails case-insensitively', () => {
    expect(teamRoleOf(teams.gizmo, { id: 'ADA' })).toBe('maintainer')
    expect(teamRoleOf(teams.gizmo, { id: 'u2', email: 'Bob@Example.com' })).toBe('member')
    expect(teamRoleOf(teams.gizmo, { id: 'cy' })).toBeUndefined()
    expect(teamsOfPrincipal(teams, { id: 'cy' })).toEqual(['kit'])
  })

  test('teamGrants: owners, members and consumers', () => {
    expect(teamGrants(teams, { id: 'ada' })).toEqual([
      { scope: { teams: ['gizmo'] }, actions: ['*'] },
      { scope: { repos: ['acme/shared/**'] }, actions: [...CONSUMER_ACTIONS] },
    ])
    const bob = {
      id: 'u2',
      name: 'Bob',
      provider: 'test',
      grants: teamGrants(teams, { id: 'u2', email: 'bob@example.com' }),
    }
    const repo = (path: string) => ({
      kind: 'repo' as const,
      repo: { forge: 'work', path, teams: teamsOwning(teams, 'work', path) },
    })
    expect(can(bob, 'releases:run', repo('acme/round/web'))).toBe(true)
    expect(can(bob, 'settings:write', repo('acme/round/web'))).toBe(false)
    expect(can(bob, 'repos:read', repo('acme/shared/other'))).toBe(true)
    expect(can(bob, 'releases:run', repo('acme/shared/other'))).toBe(false)
    expect(can(bob, 'repos:read', repo('tools/cli'))).toBe(false)
    expect(teamGrants(teams, { id: 'nobody' })).toEqual([])
  })
})
