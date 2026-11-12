import { expect, test } from 'bun:test'

import { otherTeamsText } from './other-teams.ts'

test('counts items and teams', () => {
  expect(otherTeamsText(40, 3)).toBe('40 repositories of 3 other teams')
  expect(otherTeamsText(1, 1)).toBe('1 repository of 1 other team')
  expect(otherTeamsText(5, 2, { one: 'library', many: 'libraries' })).toBe(
    '5 libraries of 2 other teams',
  )
  expect(otherTeamsText(2, 0, { one: 'job' })).toBe('2 jobs of other teams')
})
