import { describe, expect, test } from 'bun:test'

import { guideScopeKey, guideTaskOf, parseGuideScope, scopesFor } from './model.ts'

describe('scopes', () => {
  test('keys round-trip', () => {
    for (const key of [
      'all',
      'team:widgets',
      'path:work:acme/round',
      'family:f1',
      'repo:work:acme/round/web',
    ])
      expect(guideScopeKey(parseGuideScope(key)!)).toBe(key as never)
    expect(parseGuideScope('repo:work:acme/round/web')).toEqual({
      kind: 'repo',
      forge: 'work',
      path: 'acme/round/web',
    })
    expect(parseGuideScope('path:work:acme/round')).toEqual({
      kind: 'path',
      forge: 'work',
      folder: 'acme/round',
    })
    for (const bad of [
      '',
      'team:',
      'group:widgets',
      'path:work',
      'path:work:',
      'repo:work',
      'repo:work:',
      'repo::x',
    ])
      expect(parseGuideScope(bad)).toBeUndefined()
  })

  test('scopesFor lists the repository, family, folders deepest first, owner teams and all', () => {
    expect(
      scopesFor({ forge: 'work', path: 'acme/round/web', teams: ['widgets', 'gizmo'] }, 'f1'),
    ).toEqual([
      'repo:work:acme/round/web',
      'family:f1',
      'path:work:acme/round',
      'path:work:acme',
      'team:widgets',
      'team:gizmo',
      'all',
    ])
  })

  test('scopesFor keeps the owner teams in their given order', () => {
    expect(scopesFor({ forge: 'work', path: 'acme/web', teams: ['gizmo', 'widgets'] })).toEqual([
      'repo:work:acme/web',
      'path:work:acme',
      'team:gizmo',
      'team:widgets',
      'all',
    ])
  })

  test('a repository at the root with no owner has only itself and all', () => {
    expect(scopesFor({ forge: 'work', path: 'web', teams: [] })).toEqual(['repo:work:web', 'all'])
  })

  test('guideTaskOf maps agent task kinds', () => {
    expect(guideTaskOf('review')).toEqual({ task: 'review' })
    expect(guideTaskOf('release-notes')).toEqual({ task: 'release-notes' })
    expect(guideTaskOf('tests')).toEqual({ task: 'agent', section: 'testing' })
    expect(guideTaskOf('refactor')).toEqual({ task: 'agent' })
  })
})
