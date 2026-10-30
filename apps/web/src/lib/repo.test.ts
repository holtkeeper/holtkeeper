import { expect, test } from 'bun:test'

import { parseRepoKey, repoKey, repoName } from './repo.ts'

test('repo keys round-trip', () => {
  const repo = { forge: 'work', path: 'games/slots-x' }
  expect(repoKey(repo)).toBe('work:games/slots-x')
  expect(parseRepoKey('work:games/slots-x')).toEqual(repo)
  expect(parseRepoKey('nope')).toBeUndefined()
  expect(parseRepoKey(':x')).toBeUndefined()
  expect(parseRepoKey(undefined)).toBeUndefined()
  expect(repoName(repo)).toBe('slots-x')
})
