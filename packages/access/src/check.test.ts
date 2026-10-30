import { describe, expect, test } from 'bun:test'

import {
  can,
  canDelegate,
  groupNames,
  grantsWithin,
  scopeCoversRepo,
  scopeSpecificity,
  scopeWithin,
} from './check.ts'
import { type Grant, type Principal, rootPrincipal } from './model.ts'

const repo = (path: string, groups: string[] = [], forge = 'work') => ({ forge, path, groups })
const principal = (grants: Grant[]): Principal => ({ id: 'u', name: 'u', provider: 'test', grants })

describe('scopeCoversRepo', () => {
  test('matches groups, globs and forge prefixes', () => {
    expect(scopeCoversRepo({ groups: ['games'] }, repo('x/y', ['games']))).toBe(true)
    expect(scopeCoversRepo({ repos: ['games/**'] }, repo('games/app/a'))).toBe(true)
    expect(scopeCoversRepo({ repos: ['work:games/*'] }, repo('games/a'))).toBe(true)
    expect(scopeCoversRepo({ repos: ['other:games/*'] }, repo('games/a'))).toBe(false)
    expect(scopeCoversRepo({}, repo('games/a'))).toBe(false)
  })

  test('requires every group of an intersection', () => {
    const storefrontUi = { groups: [['frontend', 'storefront']] }
    expect(scopeCoversRepo(storefrontUi, repo('shop/web', ['frontend', 'storefront']))).toBe(true)
    expect(scopeCoversRepo(storefrontUi, repo('shop/api', ['backend', 'storefront']))).toBe(false)
    expect(scopeCoversRepo(storefrontUi, repo('admin/web', ['frontend', 'admin-panel']))).toBe(
      false,
    )
  })

  test('combines entries with OR', () => {
    const scope = { groups: ['tools', ['frontend', 'admin-panel', 'catalog']] }
    expect(scopeCoversRepo(scope, repo('cli', ['tools']))).toBe(true)
    expect(
      scopeCoversRepo(scope, repo('admin/catalog', ['frontend', 'admin-panel', 'catalog'])),
    ).toBe(true)
    expect(scopeCoversRepo(scope, repo('admin/orders', ['frontend', 'admin-panel']))).toBe(false)
  })
})

describe('groupNames', () => {
  test('lists every group once', () => {
    expect(groupNames(['tools', ['frontend', 'tools']])).toEqual(['tools', 'frontend'])
  })
})

describe('scopeSpecificity', () => {
  test('ranks intersections between groups and path globs', () => {
    const ranks = [
      { all: true },
      { groups: ['frontend'] },
      { groups: [['frontend', 'storefront']] },
      { groups: ['frontend', ['frontend', 'admin-panel', 'catalog']] },
      { repos: ['shop/*'] },
      { repos: ['work:shop/web'] },
    ].map(scopeSpecificity)
    expect(ranks).toEqual(ranks.toSorted((a, b) => a - b))
    expect(new Set(ranks).size).toBe(ranks.length)
    expect(scopeSpecificity({ groups: [['frontend', 'frontend']] })).toBe(1)
  })
})

describe('scopeWithin', () => {
  test('accepts narrower scopes', () => {
    expect(scopeWithin({ repos: ['games/app/**'] }, { repos: ['games/**'] })).toBe(true)
    expect(scopeWithin({ repos: ['games/app-x'] }, { repos: ['games/*'] })).toBe(true)
    expect(scopeWithin({ groups: ['games'] }, { groups: ['games', 'tools'] })).toBe(true)
    expect(scopeWithin({ all: true }, { all: true })).toBe(true)
    expect(scopeWithin({ groups: [['frontend', 'storefront']] }, { groups: ['frontend'] })).toBe(
      true,
    )
    expect(
      scopeWithin(
        { groups: [['frontend', 'admin-panel', 'catalog']] },
        { groups: [['admin-panel', 'frontend']] },
      ),
    ).toBe(true)
    expect(scopeWithin({ groups: ['frontend'] }, { groups: [['frontend']] })).toBe(true)
  })

  test('rejects wider or unprovable scopes', () => {
    expect(scopeWithin({ repos: ['games/**'] }, { repos: ['games/app/**'] })).toBe(false)
    expect(scopeWithin({ all: true }, { groups: ['games'] })).toBe(false)
    expect(scopeWithin({ groups: ['tools'] }, { groups: ['games'] })).toBe(false)
    expect(scopeWithin({ groups: ['frontend'] }, { groups: [['frontend', 'storefront']] })).toBe(
      false,
    )
    expect(
      scopeWithin({ groups: [['frontend', 'catalog']] }, { groups: [['frontend', 'storefront']] }),
    ).toBe(false)
    expect(scopeWithin({ repos: ['games/*-x'] }, { repos: ['games/*'] })).toBe(false)
    expect(scopeWithin({ repos: ['games/a'] }, { repos: ['other:games/**'] })).toBe(false)
  })
})

describe('can', () => {
  const gamesAdmin = principal([
    { scope: { repos: ['games/**'] }, actions: ['*'] },
    { scope: { groups: ['tools'] }, actions: ['audits:read'] },
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
})

describe('delegation', () => {
  const gamesAdmin = principal([{ scope: { repos: ['games/**'] }, actions: ['*'] }])
  const reader = principal([{ scope: { all: true }, actions: ['audits:read'] }])

  test('allows handing out a subset of own access', () => {
    const grants: Grant[] = [{ scope: { repos: ['games/app/**'] }, actions: ['*'] }]
    expect(grantsWithin(grants, gamesAdmin.grants)).toBe(true)
    expect(canDelegate(gamesAdmin, grants)).toBe(true)
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
})
