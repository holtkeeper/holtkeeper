import { expect, test } from 'bun:test'

import {
  auditFreshness,
  parseRepoKey,
  repoInitials,
  repoKey,
  repoName,
  splitRepoPath,
  validateGroupId,
  validateRepoPath,
  withRepo,
} from './repo.ts'

test('repo keys round-trip', () => {
  const repo = { forge: 'work', path: 'games/app-x' }
  expect(repoKey(repo)).toBe('work:games/app-x')
  expect(parseRepoKey('work:games/app-x')).toEqual(repo)
  expect(parseRepoKey('nope')).toBeUndefined()
  expect(parseRepoKey(':x')).toBeUndefined()
  expect(parseRepoKey(undefined)).toBeUndefined()
  expect(repoName(repo)).toBe('app-x')
})

test('repository paths and group ids are checked before saving', () => {
  expect(validateRepoPath('games/app')).toBeUndefined()
  expect(validateRepoPath('')).toBe('Enter the repository path')
  expect(validateRepoPath('/games/app')).toBe('No leading or trailing "/"')
  expect(validateRepoPath('games/*')).toBe('Use an exact path; edit the group for patterns')
  expect(validateRepoPath('app')).toBe('Include the namespace: team/app')
  expect(validateGroupId('games-2')).toBeUndefined()
  expect(validateGroupId('Games')).toBe('Lowercase letters, digits and dashes')
})

test('withRepo adds a path once and lifts its exclusion', () => {
  expect(withRepo(undefined, 'work', 'games/app')).toEqual({
    forge: 'work',
    include: ['games/app'],
    exclude: [],
  })
  const group = { forge: 'work', include: ['games/*'], exclude: ['games/app'] }
  expect(withRepo(group, 'other', 'games/app')).toEqual({
    forge: 'work',
    include: ['games/*', 'games/app'],
    exclude: [],
  })
  expect(withRepo(withRepo(group, 'work', 'games/app'), 'work', 'games/app').include).toEqual([
    'games/*',
    'games/app',
  ])
})

test('splitRepoPath separates the namespace from the name', () => {
  expect(splitRepoPath('acme/billing/frontend-libs')).toEqual({
    namespace: 'acme/billing/',
    name: 'frontend-libs',
  })
  expect(splitRepoPath('solo')).toEqual({ namespace: '', name: 'solo' })
})

test('auditFreshness buckets by age', () => {
  const now = new Date('2026-10-30T00:00:00.000Z')
  expect(auditFreshness(undefined, now)).toBe('never')
  expect(auditFreshness('2026-10-25T00:00:00.000Z', now)).toBe('fresh')
  expect(auditFreshness('2026-10-10T00:00:00.000Z', now)).toBe('aging')
  expect(auditFreshness('2026-08-01T00:00:00.000Z', now)).toBe('stale')
})

test('repoInitials match the server-generated avatar', () => {
  expect(repoInitials('acme/data-tools/dealer-frontend')).toBe('DD')
  expect(repoInitials('game-frontend')).toBe('GF')
  expect(repoInitials('api')).toBe('AP')
})
