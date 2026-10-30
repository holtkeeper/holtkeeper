import { describe, expect, test } from 'bun:test'

import { can, canDelegate, grantsWithin, scopeCoversRepo, scopeWithin } from './check.ts'
import { type Grant, type Principal, rootPrincipal } from './model.ts'

const repo = (path: string, groups: string[] = [], forge = 'work') => ({ forge, path, groups })
const principal = (grants: Grant[]): Principal => ({ id: 'u', name: 'u', provider: 'test', grants })

describe('scopeCoversRepo', () => {
  test('matches groups, globs and forge prefixes', () => {
    expect(scopeCoversRepo({ groups: ['games'] }, repo('x/y', ['games']))).toBe(true)
    expect(scopeCoversRepo({ repos: ['games/**'] }, repo('games/slots/a'))).toBe(true)
    expect(scopeCoversRepo({ repos: ['work:games/*'] }, repo('games/a'))).toBe(true)
    expect(scopeCoversRepo({ repos: ['other:games/*'] }, repo('games/a'))).toBe(false)
    expect(scopeCoversRepo({}, repo('games/a'))).toBe(false)
  })
})

describe('scopeWithin', () => {
  test('accepts narrower scopes', () => {
    expect(scopeWithin({ repos: ['games/slots/**'] }, { repos: ['games/**'] })).toBe(true)
    expect(scopeWithin({ repos: ['games/slots-x'] }, { repos: ['games/*'] })).toBe(true)
    expect(scopeWithin({ groups: ['games'] }, { groups: ['games', 'tools'] })).toBe(true)
    expect(scopeWithin({ all: true }, { all: true })).toBe(true)
  })

  test('rejects wider or unprovable scopes', () => {
    expect(scopeWithin({ repos: ['games/**'] }, { repos: ['games/slots/**'] })).toBe(false)
    expect(scopeWithin({ all: true }, { groups: ['games'] })).toBe(false)
    expect(scopeWithin({ groups: ['tools'] }, { groups: ['games'] })).toBe(false)
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
      can(gamesAdmin, 'credentials:write', { kind: 'scope', scope: { repos: ['games/slots/**'] } }),
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
    const grants: Grant[] = [{ scope: { repos: ['games/slots/**'] }, actions: ['*'] }]
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
