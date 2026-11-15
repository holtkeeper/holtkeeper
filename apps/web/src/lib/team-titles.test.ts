import { describe, expect, test } from 'bun:test'

import {
  byTeamTitle,
  keyAsTitle,
  teamMatchesQuery,
  teamTitleOf,
  validateTeamKey,
  validateTeamTitle,
  withTeamTitle,
} from './team-titles.ts'

const titleOf = teamTitleOf({ widgets: 'Widget works', gizmo: 'Gizmo lab' })

describe('team titles', () => {
  test('shows the title, else the key', () => {
    expect(titleOf('widgets')).toBe('Widget works')
    expect(titleOf('sounds')).toBe('sounds')
    expect(titleOf('toString')).toBe('toString')
    expect(teamTitleOf(undefined)('widgets')).toBe('widgets')
    expect(keyAsTitle('widgets')).toBe('widgets')
  })

  test('sorts by title and filters by title or key', () => {
    expect(['widgets', 'sounds', 'gizmo'].toSorted(byTeamTitle(titleOf))).toEqual([
      'gizmo',
      'sounds',
      'widgets',
    ])
    expect(teamMatchesQuery('widgets', titleOf, 'works')).toBeTrue()
    expect(teamMatchesQuery('widgets', titleOf, 'WID')).toBeTrue()
    expect(teamMatchesQuery('widgets', titleOf, 'lab')).toBeFalse()
    expect(teamMatchesQuery('widgets', titleOf, ' ')).toBeTrue()
  })

  test('edits the display name of a team document', () => {
    const data = { owns: ['acme/round/**'], exclude: [], consumes: [], members: [] }
    expect(withTeamTitle(data, '  Widget works ')).toEqual({ ...data, title: 'Widget works' })
    expect(withTeamTitle({ ...data, title: 'Old' }, ' ')).toEqual(data)
    expect(validateTeamTitle('x'.repeat(60))).toBeUndefined()
    expect(validateTeamTitle('x'.repeat(61))).toBe('At most 60 characters')
  })

  test('checks team keys: flat, no dots', () => {
    expect(validateTeamKey('widgets')).toBeUndefined()
    expect(validateTeamKey('round-2')).toBeUndefined()
    expect(validateTeamKey('widgets.round')).toBeDefined()
    expect(validateTeamKey('Widgets')).toBeDefined()
    expect(validateTeamKey('2d')).toBeDefined()
  })
})
