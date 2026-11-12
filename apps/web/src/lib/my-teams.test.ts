import { describe, expect, test } from 'bun:test'

import { homeCombinations, teamRows, toggleHomeGroup } from './my-teams.ts'

describe('my teams', () => {
  const repos = [
    {
      repo: { forge: 'work', path: 'acme/widgets' },
      groups: ['web', 'shared'],
      health: 'failing' as const,
    },
    { repo: { forge: 'hub', path: 'acme/gadgets' }, groups: ['web'], health: 'healthy' as const },
    { repo: { forge: 'work', path: 'acme/ledger' }, groups: ['payments'] },
  ]
  const none = { failing: 0, warnings: 0, 'not-analysed': 0, healthy: 0 }

  test('lists every group with its repositories, forges, health and whether My teams has it', () => {
    expect(teamRows(repos, ['web', ['payments', 'shared']])).toEqual([
      { group: 'payments', repos: 1, forges: ['work'], inMyTeams: false, health: none },
      {
        group: 'shared',
        repos: 1,
        forges: ['work'],
        inMyTeams: false,
        health: { ...none, failing: 1 },
      },
      {
        group: 'web',
        repos: 2,
        forges: ['hub', 'work'],
        inMyTeams: true,
        health: { ...none, failing: 1, healthy: 1 },
      },
    ])
  })

  test('lists subgroups after their parent, each a home group on its own', () => {
    const nested = [
      { repo: { forge: 'work', path: 'acme/disc' }, groups: ['shapes.round', 'shapes'] },
      { repo: { forge: 'work', path: 'acme/beep' }, groups: ['sounds'] },
      { repo: { forge: 'work', path: 'acme/cube' }, groups: ['shapes'] },
    ]
    const rows = teamRows(nested, ['shapes.round'], (key) => (key === 'sounds' ? 'Audio' : key))
    expect(rows.map((row) => [row.group, row.parent, row.repos, row.inMyTeams])).toEqual([
      ['sounds', undefined, 1, false],
      ['shapes', undefined, 2, false],
      ['shapes.round', 'shapes', 1, true],
    ])
  })

  test('toggling a group keeps combinations', () => {
    const home = ['web', ['payments', 'shared']]
    expect(toggleHomeGroup(home, 'shared', true)).toEqual(['web', ['payments', 'shared'], 'shared'])
    expect(toggleHomeGroup(home, 'web', true)).toEqual(home)
    expect(toggleHomeGroup(home, 'web', false)).toEqual([['payments', 'shared']])
    expect(homeCombinations(home)).toEqual([['payments', 'shared']])
  })
})
