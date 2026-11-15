import { describe, expect, test } from 'bun:test'

import {
  describeScope,
  folderPatterns,
  isEmptyScope,
  isSharedScope,
  namesFocus,
  normalizeScope,
  previewPatterns,
  reposMatching,
  scopeCoversRepo,
  scopeOfFocus,
  scopeOrder,
  validateRepoPattern,
  validateRootedPattern,
} from './scope.ts'
import { teamTitleOf } from './team-titles.ts'

const repo = (key: string, ...teams: string[]) => {
  const [forge = '', path = ''] = key.split(':')
  return { repo: { forge, path }, teams }
}

describe('scopes', () => {
  test('describe', () => {
    expect(describeScope({ all: true })).toBe('everything')
    expect(describeScope({ teams: ['widgets'], repos: ['work:acme/round/**'] })).toBe(
      'team widgets, work:acme/round/**',
    )
    expect(describeScope({})).toBe('nothing')
    const titleOf = teamTitleOf({ widgets: 'Widget works' })
    expect(describeScope({ teams: ['widgets', 'gizmo'] }, titleOf)).toBe(
      'team Widget works, team gizmo',
    )
  })

  test('normalize', () => {
    expect(normalizeScope({ all: true, teams: ['x'] })).toEqual({ all: true })
    expect(normalizeScope({ teams: [' a ', 'a', ''], repos: [] })).toEqual({ teams: ['a'] })
    expect(normalizeScope({ repos: ['acme/** ', 'acme/**'] })).toEqual({ repos: ['acme/**'] })
    expect(isEmptyScope({ teams: [] })).toBe(true)
    expect(isEmptyScope({ repos: ['x'] })).toBe(false)
  })

  test('validate patterns', () => {
    expect(validateRepoPattern('work:acme/**')).toBeUndefined()
    expect(validateRepoPattern('acme/*')).toBeUndefined()
    expect(validateRepoPattern('')).toBe('Pattern is empty')
    expect(validateRepoPattern(':x')).toBe('Forge id before ":" is empty')
    expect(validateRepoPattern('work:')).toBe('Path after ":" is empty')
    expect(validateRepoPattern('/abs')).toBe('Paths are relative, without a leading "/"')
    expect(validateRepoPattern('a b')).toBe('Patterns cannot contain spaces')
    expect(validateRootedPattern('acme/*/web')).toBeUndefined()
    expect(validateRootedPattern('work:acme/**')).toBeUndefined()
    expect(validateRootedPattern('**/web')).toBe('Start with a folder, e.g. acme/**')
    expect(validateRootedPattern('work:*/web')).toBe('Start with a folder, e.g. acme/**')
  })

  test('order', () => {
    expect([{ repos: ['x'] }, { all: true }, { teams: ['g'] }].map(scopeOrder)).toEqual([2, 0, 1])
  })

  test('previews which repositories a scope covers', () => {
    const web = repo('work:acme/round/web', 'widgets')
    const api = repo('work:acme/square/api')
    expect(scopeCoversRepo({ all: true }, api)).toBe(true)
    expect(scopeCoversRepo({ teams: ['widgets'] }, web)).toBe(true)
    expect(scopeCoversRepo({ teams: ['widgets'] }, api)).toBe(false)
    expect(scopeCoversRepo({ repos: ['acme/*/api'] }, api)).toBe(true)
    expect(scopeCoversRepo({ repos: ['other:acme/**'] }, api)).toBe(false)
    expect(reposMatching('acme/round/**', [web, api])).toEqual([web])
  })

  test('focus of a repository or team page', () => {
    const focus = { kind: 'repo' as const, repo: { forge: 'work', path: 'acme/round/web' } }
    const team = { kind: 'team' as const, team: 'widgets' }
    expect(scopeOfFocus(focus)).toEqual({ repos: ['work:acme/round/web'] })
    expect(scopeOfFocus(team)).toEqual({ teams: ['widgets'] })
    expect(namesFocus({ repos: ['work:acme/round/web'] }, focus)).toBe(true)
    expect(namesFocus({ repos: ['acme/round/web'] }, focus)).toBe(true)
    expect(namesFocus({ repos: ['acme/round/*'] }, focus)).toBe(false)
    expect(namesFocus({ all: true }, focus)).toBe(false)
    expect(namesFocus({ teams: ['widgets', 'gizmo'] }, team)).toBe(true)
    expect(namesFocus({ teams: ['gizmo'] }, team)).toBe(false)
    expect(isSharedScope({ teams: ['widgets'] })).toBe(false)
    expect(isSharedScope({ teams: ['widgets'], repos: ['x/y'] })).toBe(true)
    expect(isSharedScope({ all: true })).toBe(true)
  })
})

describe('folder patterns and previews', () => {
  const repos = [
    { repo: { forge: 'work', path: 'acme/round/web' } },
    { repo: { forge: 'work', path: 'acme/round/api' } },
    { repo: { forge: 'work', path: 'acme/tools' } },
  ]

  test('suggests every folder, without the forge while there is one', () => {
    expect(folderPatterns(repos.map((r) => r.repo))).toEqual(['acme/**', 'acme/round/**'])
    expect(
      folderPatterns([...repos.map((r) => r.repo), { forge: 'home', path: 'gizmo/cli' }]),
    ).toEqual(['home:gizmo/**', 'work:acme/**', 'work:acme/round/**'])
  })

  test('previews the union of patterns', () => {
    const preview = previewPatterns(['acme/round/**', 'work:acme/round/web'], repos, 1)
    expect(preview.total).toBe(2)
    expect(preview.sample.map((r) => r.repo.path)).toEqual(['acme/round/web'])
  })
})
