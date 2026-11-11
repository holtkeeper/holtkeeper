import { describe, expect, test } from 'bun:test'

import type { Principal } from '@holtkeeper/api'

import { actions, can, canCatalog, canGlobal, summarizeGrants } from './access.ts'

const principal = (grants: Principal['grants']): Principal => ({
  id: 'u',
  name: 'U',
  provider: 'users',
  grants,
})

describe('can', () => {
  test('is false without a principal', () => {
    expect(can(null, 'repos:read')).toBe(false)
    expect(can(undefined, 'repos:read')).toBe(false)
  })

  test('accepts the wildcard and listed actions regardless of scope', () => {
    expect(can(principal([{ scope: { all: true }, actions: ['*'] }]), 'users:write')).toBe(true)
    const scoped = principal([{ scope: { repos: ['work:games/**'] }, actions: ['audits:read'] }])
    expect(can(scoped, 'audits:read')).toBe(true)
    expect(can(scoped, 'audits:run')).toBe(false)
  })

  test('checks every grant', () => {
    const p = principal([
      { scope: { groups: ['a'] }, actions: ['repos:read'] },
      { scope: { groups: ['b'] }, actions: ['settings:write'] },
    ])
    expect(can(p, 'settings:write')).toBe(true)
    expect(can(p, 'credentials:read')).toBe(false)
  })
})

describe('summarizeGrants', () => {
  test('describes grants briefly', () => {
    expect(summarizeGrants([])).toBe('no access')
    expect(summarizeGrants([{ scope: { all: true }, actions: ['*'] }])).toBe('all actions')
    expect(
      summarizeGrants([
        { scope: { all: true }, actions: ['repos:read'] },
        { scope: { groups: ['x'] }, actions: ['repos:read', 'audits:read'] },
      ]),
    ).toBe('2 grants, 2 actions')
  })

  test('lists all twenty-two actions', () => {
    expect(actions).toHaveLength(22)
  })
})

describe('canGlobal', () => {
  test('needs a grant over everything that allows the action', () => {
    expect(canGlobal(null, 'settings:read')).toBe(false)
    const scoped = principal([{ scope: { groups: ['games'] }, actions: ['settings:read'] }])
    expect(canGlobal(scoped, 'settings:read')).toBe(false)
    expect(canGlobal(principal([{ scope: { all: true }, actions: ['*'] }]), 'settings:read')).toBe(
      true,
    )
    const all = principal([{ scope: { all: true }, actions: ['settings:read'] }])
    expect(canGlobal(all, 'settings:read')).toBe(true)
    expect(canGlobal(all, 'settings:write')).toBe(false)
  })
})

const holder = (action: Principal['grants'][number]['actions'][number]): Principal => ({
  id: 'p',
  name: 'P',
  provider: 'users',
  grants: [{ scope: { groups: ['games'] }, actions: [action] }],
})

describe('canCatalog', () => {
  test('catalog and analyses grants reach the catalog under every level', () => {
    expect(canCatalog(holder('catalog:read'), 'off')).toBe(true)
    expect(canCatalog(holder('analyses:read'), 'off')).toBe(true)
  })

  test('a plain read grant reaches it only while cross-team reach is on', () => {
    expect(canCatalog(holder('repos:read'), 'metadata')).toBe(true)
    expect(canCatalog(holder('repos:read'), 'off')).toBe(false)
    expect(canCatalog(holder('audits:read'), 'snippets')).toBe(false)
    expect(canCatalog(null, 'snippets')).toBe(false)
  })
})
