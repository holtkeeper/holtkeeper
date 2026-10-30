import { expect, test } from 'bun:test'

import {
  parseRepoKey,
  repoKey,
  repoName,
  validateGroupId,
  validateRepoPath,
  withRepo,
} from './repo.ts'

test('repo keys round-trip', () => {
  const repo = { forge: 'work', path: 'games/slots-x' }
  expect(repoKey(repo)).toBe('work:games/slots-x')
  expect(parseRepoKey('work:games/slots-x')).toEqual(repo)
  expect(parseRepoKey('nope')).toBeUndefined()
  expect(parseRepoKey(':x')).toBeUndefined()
  expect(parseRepoKey(undefined)).toBeUndefined()
  expect(repoName(repo)).toBe('slots-x')
})

test('repository paths and group ids are checked before saving', () => {
  expect(validateRepoPath('games/slots')).toBeUndefined()
  expect(validateRepoPath('')).toBe('Enter the repository path')
  expect(validateRepoPath('/games/slots')).toBe('No leading or trailing "/"')
  expect(validateRepoPath('games/*')).toBe('Use an exact path; edit the group for patterns')
  expect(validateRepoPath('slots')).toBe('Include the namespace: team/app')
  expect(validateGroupId('games-2')).toBeUndefined()
  expect(validateGroupId('Games')).toBe('Lowercase letters, digits and dashes')
})

test('withRepo adds a path once and lifts its exclusion', () => {
  expect(withRepo(undefined, 'work', 'games/slots')).toEqual({
    forge: 'work',
    include: ['games/slots'],
    exclude: [],
  })
  const group = { forge: 'work', include: ['games/*'], exclude: ['games/slots'] }
  expect(withRepo(group, 'other', 'games/slots')).toEqual({
    forge: 'work',
    include: ['games/*', 'games/slots'],
    exclude: [],
  })
  expect(withRepo(withRepo(group, 'work', 'games/slots'), 'work', 'games/slots').include).toEqual([
    'games/*',
    'games/slots',
  ])
})
