import { describe, expect, test } from 'bun:test'

import type { Principal } from '@holtkeeper/api'

import { actions, can, summarizeGrants } from './access.ts'

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

  test('lists all twenty actions', () => {
    expect(actions).toHaveLength(20)
  })
})
