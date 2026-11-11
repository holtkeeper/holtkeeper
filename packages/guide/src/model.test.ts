import { describe, expect, test } from 'bun:test'

import { guideScopeKey, guideTaskOf, parseGuideScope, scopesFor } from './model.ts'

describe('scopes', () => {
  test('keys round-trip', () => {
    for (const key of ['all', 'group:games', 'family:f1', 'repo:work:games/app/web'])
      expect(guideScopeKey(parseGuideScope(key)!)).toBe(key as never)
    expect(parseGuideScope('repo:work:games/a')).toEqual({
      kind: 'repo',
      forge: 'work',
      path: 'games/a',
    })
    for (const bad of ['', 'group:', 'team:x', 'repo:work', 'repo:work:', 'repo::x'])
      expect(parseGuideScope(bad)).toBeUndefined()
  })

  test('scopesFor lists the repository, family, groups and all', () => {
    expect(scopesFor({ forge: 'work', path: 'games/a', groups: ['games', 'web'] }, 'f1')).toEqual([
      'repo:work:games/a',
      'family:f1',
      'group:games',
      'group:web',
      'all',
    ])
    expect(scopesFor({ forge: 'work', path: 'games/a', groups: [] })).toEqual([
      'repo:work:games/a',
      'all',
    ])
  })

  test('guideTaskOf maps agent task kinds', () => {
    expect(guideTaskOf('review')).toEqual({ task: 'review' })
    expect(guideTaskOf('release-notes')).toEqual({ task: 'release-notes' })
    expect(guideTaskOf('tests')).toEqual({ task: 'agent', section: 'testing' })
    expect(guideTaskOf('refactor')).toEqual({ task: 'agent' })
  })
})
