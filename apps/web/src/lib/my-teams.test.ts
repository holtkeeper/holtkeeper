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

  test('toggling a group keeps combinations', () => {
    const home = ['web', ['payments', 'shared']]
    expect(toggleHomeGroup(home, 'shared', true)).toEqual(['web', ['payments', 'shared'], 'shared'])
    expect(toggleHomeGroup(home, 'web', true)).toEqual(home)
    expect(toggleHomeGroup(home, 'web', false)).toEqual([['payments', 'shared']])
    expect(homeCombinations(home)).toEqual([['payments', 'shared']])
  })
})
