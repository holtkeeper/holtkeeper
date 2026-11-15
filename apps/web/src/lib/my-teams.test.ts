import { describe, expect, test } from 'bun:test'

import { myTeamRows, toggleHomeTeam } from './my-teams.ts'

describe('my teams', () => {
  const repos = [
    {
      repo: { forge: 'work', path: 'acme/round/web' },
      teams: ['widgets', 'shared'],
      health: 'failing' as const,
    },
    {
      repo: { forge: 'hub', path: 'acme/round/api' },
      teams: ['widgets'],
      health: 'healthy' as const,
    },
    { repo: { forge: 'work', path: 'acme/tools' }, teams: ['gizmo'] },
  ]
  const none = { failing: 0, warnings: 0, 'not-analysed': 0, healthy: 0 }

  test('lists every team with its repositories, forges, health and whether My teams has it', () => {
    expect(myTeamRows(repos, ['widgets'])).toEqual([
      { team: 'gizmo', repos: 1, forges: ['work'], inMyTeams: false, health: none },
      {
        team: 'shared',
        repos: 1,
        forges: ['work'],
        inMyTeams: false,
        health: { ...none, failing: 1 },
      },
      {
        team: 'widgets',
        repos: 2,
        forges: ['hub', 'work'],
        inMyTeams: true,
        health: { ...none, failing: 1, healthy: 1 },
      },
    ])
  })

  test('keeps known and home teams that own nothing visible, sorted by title', () => {
    const rows = myTeamRows([], ['spare'], (key) => (key === 'spare' ? 'A spare team' : key), [
      'zeta',
    ])
    expect(rows.map((row) => [row.team, row.repos, row.inMyTeams])).toEqual([
      ['spare', 0, true],
      ['zeta', 0, false],
    ])
  })

  test('toggles a home team', () => {
    expect(toggleHomeTeam(['widgets'], 'gizmo', true)).toEqual(['widgets', 'gizmo'])
    expect(toggleHomeTeam(['widgets'], 'widgets', true)).toEqual(['widgets'])
    expect(toggleHomeTeam(['widgets', 'gizmo'], 'widgets', false)).toEqual(['gizmo'])
  })
})
