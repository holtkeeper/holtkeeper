import { describe, expect, test } from 'bun:test'

import {
  describeScope,
  isEmptyScope,
  normalizeScope,
  scopeOrder,
  validateRepoPattern,
} from './scope.ts'

describe('scopes', () => {
  test('describe', () => {
    expect(describeScope({ all: true })).toBe('everything')
    expect(describeScope({ groups: ['games'], repos: ['work:games/**'] })).toBe(
      'group games, work:games/**',
    )
    expect(describeScope({})).toBe('nothing')
  })

  test('normalize', () => {
    expect(normalizeScope({ all: true, groups: ['x'] })).toEqual({ all: true })
    expect(normalizeScope({ groups: [' a ', 'a', ''], repos: [] })).toEqual({ groups: ['a'] })
    expect(isEmptyScope({ groups: [] })).toBe(true)
    expect(isEmptyScope({ repos: ['x'] })).toBe(false)
  })

  test('validate patterns', () => {
    expect(validateRepoPattern('work:games/**')).toBeUndefined()
    expect(validateRepoPattern('games/*')).toBeUndefined()
    expect(validateRepoPattern('')).toBe('Pattern is empty')
    expect(validateRepoPattern(':x')).toBe('Forge id before ":" is empty')
    expect(validateRepoPattern('work:')).toBe('Path after ":" is empty')
    expect(validateRepoPattern('/abs')).toBe('Paths are relative, without a leading "/"')
    expect(validateRepoPattern('a b')).toBe('Patterns cannot contain spaces')
  })

  test('order', () => {
    expect([{ repos: ['x'] }, { all: true }, { groups: ['g'] }].map(scopeOrder)).toEqual([2, 0, 1])
  })
})
