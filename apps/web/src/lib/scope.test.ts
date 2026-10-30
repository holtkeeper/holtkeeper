import { describe, expect, test } from 'bun:test'

import {
  describeScope,
  formatGroupMatch,
  isEmptyScope,
  isSharedScope,
  namesFocus,
  scopeOfFocus,
  normalizeScope,
  parseGroupMatch,
  scopeOrder,
  validateGroupMatch,
  validateRepoPattern,
} from './scope.ts'

describe('scopes', () => {
  test('describe', () => {
    expect(describeScope({ all: true })).toBe('everything')
    expect(describeScope({ groups: ['games'], repos: ['work:games/**'] })).toBe(
      'group games, work:games/**',
    )
    expect(describeScope({})).toBe('nothing')
    expect(describeScope({ groups: [['frontend', 'storefront']] })).toBe(
      'group frontend + storefront',
    )
  })

  test('group intersections as text', () => {
    expect(formatGroupMatch(['frontend', 'admin-panel'])).toBe('frontend + admin-panel')
    expect(parseGroupMatch(' frontend +admin-panel ')).toEqual(['frontend', 'admin-panel'])
    expect(parseGroupMatch('frontend + frontend')).toBe('frontend')
    expect(validateGroupMatch('frontend + catalog')).toBeUndefined()
    expect(validateGroupMatch('frontend +')).toBeDefined()
    expect(validateGroupMatch('Frontend')).toBeDefined()
  })

  test('normalize', () => {
    expect(normalizeScope({ all: true, groups: ['x'] })).toEqual({ all: true })
    expect(normalizeScope({ groups: [' a ', 'a', ''], repos: [] })).toEqual({ groups: ['a'] })
    expect(normalizeScope({ groups: [['a', ' b'], ['a', 'b'], ['a']] })).toEqual({
      groups: [['a', 'b'], 'a'],
    })
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

  test('focus of a repository or group page', () => {
    const repo = { kind: 'repo' as const, repo: { forge: 'work', path: 'games/app' } }
    const group = { kind: 'group' as const, group: 'games' }
    expect(scopeOfFocus(repo)).toEqual({ repos: ['work:games/app'] })
    expect(scopeOfFocus(group)).toEqual({ groups: ['games'] })
    expect(namesFocus({ repos: ['work:games/app'] }, repo)).toBe(true)
    expect(namesFocus({ repos: ['games/app'] }, repo)).toBe(true)
    expect(namesFocus({ repos: ['games/*'] }, repo)).toBe(false)
    expect(namesFocus({ all: true }, repo)).toBe(false)
    expect(namesFocus({ groups: ['games', 'tools'] }, group)).toBe(true)
    expect(namesFocus({ groups: ['tools'] }, group)).toBe(false)
    expect(isSharedScope({ groups: ['games'] })).toBe(false)
    expect(isSharedScope({ groups: ['games'], repos: ['x/y'] })).toBe(true)
    expect(isSharedScope({ all: true })).toBe(true)
  })
})
