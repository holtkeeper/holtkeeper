import { describe, expect, test } from 'bun:test'

import {
  can,
  canDelegate,
  grantsWithin,
  scopeCoversRepo,
  scopeSpecificity,
  scopeWithin,
} from './check.ts'
import { type Grant, type Principal, rootPrincipal } from './model.ts'

const repo = (path: string, teams: string[] = [], forge = 'work') => ({ forge, path, teams })
const principal = (grants: Grant[], teamDefs?: Principal['teamDefs']): Principal => ({
  id: 'u',
  name: 'u',
  provider: 'test',
  grants,
  ...(teamDefs ? { teamDefs } : {}),
})

describe('scopeCoversRepo', () => {
  test('matches teams, globs and forge prefixes', () => {
    expect(scopeCoversRepo({ teams: ['gizmo'] }, repo('x/y', ['gizmo']))).toBe(true)
    expect(scopeCoversRepo({ teams: ['gizmo'] }, repo('x/y', ['other']))).toBe(false)
    expect(scopeCoversRepo({ repos: ['games/**'] }, repo('games/app/a'))).toBe(true)
    expect(scopeCoversRepo({ repos: ['work:games/*'] }, repo('games/a'))).toBe(true)
    expect(scopeCoversRepo({ repos: ['other:games/*'] }, repo('games/a'))).toBe(false)
    expect(scopeCoversRepo({ repos: ['acme/*/web'] }, repo('acme/round/web'))).toBe(true)
    expect(scopeCoversRepo({ repos: ['acme/*/web'] }, repo('acme/round/api'))).toBe(false)
    expect(scopeCoversRepo({}, repo('games/a'))).toBe(false)
  })

  test('combines entries with OR', () => {
    const scope = { teams: ['tools'], repos: ['acme/round/**'] }
    expect(scopeCoversRepo(scope, repo('cli', ['tools']))).toBe(true)
    expect(scopeCoversRepo(scope, repo('acme/round/web'))).toBe(true)
    expect(scopeCoversRepo(scope, repo('acme/square/web'))).toBe(false)
  })
})

describe('scopeSpecificity', () => {
  test('ranks everything < team < glob < deeper glob < exact path', () => {
    const ranks = [
      { all: true },
      { teams: ['gizmo'] },
      { repos: ['*/web'] },
      { repos: ['acme/**'] },
      { repos: ['acme/round/**'] },
      { repos: ['work:acme/round/web'] },
    ].map(scopeSpecificity)
    expect(ranks).toEqual(ranks.toSorted((a, b) => a - b))
    expect(new Set(ranks).size).toBe(ranks.length)
  })

  test('ranks a scope by its broadest entry', () => {
    expect(scopeSpecificity({ teams: ['gizmo'], repos: ['work:acme/a'] })).toBe(1)
    expect(scopeSpecificity({ repos: ['acme/**', 'work:acme/a'] })).toBe(2.1)
    expect(scopeSpecificity({})).toBe(0)
  })
})

describe('scopeWithin', () => {
  test('accepts narrower path patterns', () => {
    expect(scopeWithin({ repos: ['games/app/**'] }, { repos: ['games/**'] })).toBe(true)
    expect(scopeWithin({ repos: ['games/app-x'] }, { repos: ['games/*'] })).toBe(true)
    expect(scopeWithin({ repos: ['acme/*/web'] }, { repos: ['acme/**'] })).toBe(true)
    expect(scopeWithin({ repos: ['acme/round/web'] }, { repos: ['acme/*/web'] })).toBe(true)
    expect(scopeWithin({ repos: ['work:acme/round/web'] }, { repos: ['acme/**'] })).toBe(true)
    expect(scopeWithin({ teams: ['gizmo'] }, { teams: ['gizmo', 'tools'] })).toBe(true)
    expect(scopeWithin({ all: true }, { all: true })).toBe(true)
  })

  test('rejects wider or unprovable scopes', () => {
    expect(scopeWithin({ repos: ['games/**'] }, { repos: ['games/app/**'] })).toBe(false)
    expect(scopeWithin({ repos: ['acme/**'] }, { repos: ['acme/*/web'] })).toBe(false)
    expect(scopeWithin({ repos: ['acme/*/web'] }, { repos: ['acme/round/*'] })).toBe(false)
    expect(scopeWithin({ all: true }, { teams: ['gizmo'] })).toBe(false)
    expect(scopeWithin({ teams: ['tools'] }, { teams: ['gizmo'] })).toBe(false)
    expect(scopeWithin({ repos: ['games/*-x'] }, { repos: ['games/*'] })).toBe(true)
    expect(scopeWithin({ repos: ['games/*'] }, { repos: ['games/*-x'] })).toBe(false)
    expect(scopeWithin({ repos: ['games/a'] }, { repos: ['other:games/**'] })).toBe(false)
    expect(scopeWithin({ repos: ['games/a/**'] }, { repos: ['games/*'] })).toBe(false)
  })

  test('expands teams it knows', () => {
    const teams = {
      gizmo: { owns: ['acme/round/**', 'acme/square/**'] },
      kit: { owns: ['acme/shared/**'], exclude: ['acme/shared/legacy-*'] },
    }
    expect(scopeWithin({ repos: ['work:acme/round/web'] }, { teams: ['gizmo'] }, teams)).toBe(true)
    expect(scopeWithin({ repos: ['acme/round/**'] }, { teams: ['gizmo'] }, teams)).toBe(true)
    expect(scopeWithin({ repos: ['acme/*/web'] }, { teams: ['gizmo'] }, teams)).toBe(false)
    expect(scopeWithin({ repos: ['work:acme/round/web'] }, { teams: ['gizmo'] })).toBe(false)
    expect(scopeWithin({ teams: ['gizmo'] }, { repos: ['acme/**'] }, teams)).toBe(true)
    expect(scopeWithin({ teams: ['gizmo'] }, { repos: ['acme/round/**'] }, teams)).toBe(false)
    expect(scopeWithin({ repos: ['work:acme/shared/ui'] }, { teams: ['kit'] }, teams)).toBe(true)
    expect(scopeWithin({ repos: ['work:acme/shared/legacy-ui'] }, { teams: ['kit'] }, teams)).toBe(
      false,
    )
    expect(scopeWithin({ repos: ['acme/shared/x/**'] }, { teams: ['kit'] }, teams)).toBe(false)
  })
})

describe('can', () => {
  const gamesAdmin = principal([
    { scope: { repos: ['games/**'] }, actions: ['*'] },
    { scope: { teams: ['tools'] }, actions: ['audits:read'] },
  ])

  test('checks repository targets', () => {
    expect(can(gamesAdmin, 'releases:run', { kind: 'repo', repo: repo('games/a') })).toBe(true)
    expect(can(gamesAdmin, 'audits:read', { kind: 'repo', repo: repo('t/a', ['tools']) })).toBe(
      true,
    )
    expect(can(gamesAdmin, 'audits:run', { kind: 'repo', repo: repo('t/a', ['tools']) })).toBe(
      false,
    )
  })

  test('checks scoped objects and global targets', () => {
    expect(
      can(gamesAdmin, 'credentials:write', { kind: 'scope', scope: { repos: ['games/app/**'] } }),
    ).toBe(true)
    expect(can(gamesAdmin, 'credentials:write', { kind: 'scope', scope: { all: true } })).toBe(
      false,
    )
    expect(can(gamesAdmin, 'users:write', { kind: 'global' })).toBe(false)
    expect(can(rootPrincipal('none'), 'users:write', { kind: 'global' })).toBe(true)
  })

  test('a team grant covers path-scoped objects inside the team', () => {
    const maintainer = principal([{ scope: { teams: ['gizmo'] }, actions: ['*'] }], {
      gizmo: { owns: ['acme/round/**'] },
    })
    const scope = { repos: ['work:acme/round/web'] }
    expect(can(maintainer, 'settings:write', { kind: 'scope', scope })).toBe(true)
    expect(
      can(maintainer, 'settings:write', { kind: 'scope', scope: { repos: ['acme/**'] } }),
    ).toBe(false)
  })
})

describe('catalog:read', () => {
  const games = repo('games/a', ['games'])
  const tools = repo('tools/a', ['tools'])

  test('analyses:read implies catalog:read on the same scope only', () => {
    const reader = principal([{ scope: { teams: ['games'] }, actions: ['analyses:read'] }])
    expect(can(reader, 'catalog:read', { kind: 'repo', repo: games })).toBe(true)
    expect(can(reader, 'catalog:read', { kind: 'repo', repo: tools })).toBe(false)
  })

  test('catalog:read implies nothing else', () => {
    const catalog = principal([{ scope: { all: true }, actions: ['catalog:read'] }])
    expect(can(catalog, 'catalog:read', { kind: 'repo', repo: tools })).toBe(true)
    for (const action of ['analyses:read', 'audits:read', 'releases:read', 'repos:read'] as const)
      expect(can(catalog, action, { kind: 'repo', repo: tools })).toBe(false)
  })

  test('the grant matrix', () => {
    const cases: [Grant['actions'], boolean][] = [
      [['*'], true],
      [['analyses:read'], true],
      [['catalog:read'], true],
      [['repos:read'], false],
      [['audits:read', 'releases:read', 'knowledge:read'], false],
    ]
    for (const [actions, expected] of cases)
      expect(
        can(principal([{ scope: { all: true }, actions }]), 'catalog:read', {
          kind: 'repo',
          repo: games,
        }),
      ).toBe(expected)
  })

  test('delegating catalog:read is covered by analyses:read', () => {
    const parent: Grant[] = [{ scope: { teams: ['games'] }, actions: ['analyses:read'] }]
    expect(grantsWithin([{ scope: { teams: ['games'] }, actions: ['catalog:read'] }], parent)).toBe(
      true,
    )
    expect(grantsWithin([{ scope: { all: true }, actions: ['catalog:read'] }], parent)).toBe(false)
  })
})

describe('delegation', () => {
  const gamesAdmin = principal([{ scope: { repos: ['games/**'] }, actions: ['*'] }])
  const reader = principal([{ scope: { all: true }, actions: ['audits:read'] }])

  test('allows handing out a subset of own access', () => {
    const grants: Grant[] = [{ scope: { repos: ['games/app/**'] }, actions: ['*'] }]
    expect(grantsWithin(grants, gamesAdmin.grants)).toBe(true)
    expect(canDelegate(gamesAdmin, grants)).toBe(true)
    expect(canDelegate(gamesAdmin, [{ scope: { repos: ['games/*/web'] }, actions: ['*'] }])).toBe(
      true,
    )
  })

  test('rejects wider scopes, extra actions and missing invite rights', () => {
    expect(canDelegate(gamesAdmin, [{ scope: { all: true }, actions: ['audits:read'] }])).toBe(
      false,
    )
    expect(
      canDelegate(reader, [{ scope: { repos: ['games/**'] }, actions: ['audits:read'] }]),
    ).toBe(false)
    expect(grantsWithin([{ scope: { all: true }, actions: ['*'] }], reader.grants)).toBe(false)
  })

  test('lets a team maintainer delegate folders of the team only', () => {
    const maintainer = principal([{ scope: { teams: ['gizmo'] }, actions: ['*'] }], {
      gizmo: { owns: ['acme/round/**'] },
    })
    const folder: Grant[] = [{ scope: { repos: ['acme/round/web/**'] }, actions: ['*'] }]
    expect(canDelegate(maintainer, folder)).toBe(true)
    expect(canDelegate(maintainer, [{ scope: { teams: ['gizmo'] }, actions: ['*'] }])).toBe(true)
    expect(canDelegate(maintainer, [{ scope: { teams: ['other'] }, actions: ['*'] }])).toBe(false)
    expect(canDelegate(maintainer, [{ scope: { repos: ['acme/**'] }, actions: ['*'] }])).toBe(false)
  })
})
