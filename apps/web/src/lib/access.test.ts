import { describe, expect, test } from 'bun:test'

import type { Principal } from '@holtkeeper/api'

import {
  actionLabels,
  actions,
  can,
  canCatalog,
  canGlobal,
  canInGroup,
  roleLabel,
  summarizeGrants,
  visibleSettingsSections,
} from './access.ts'
import { grantsForRole, roleNames, roleOf, rolePresetIds } from './roles.ts'

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

  test('lists all twenty-one actions', () => {
    expect(actions).toHaveLength(21)
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

describe('canInGroup', () => {
  test('needs a grant over everything or one naming the group on its own', () => {
    const scoped = principal([
      { scope: { groups: ['games', ['web', 'pay']] }, actions: ['settings:write'] },
    ])
    expect(canInGroup(scoped, 'settings:write', 'games')).toBe(true)
    expect(canInGroup(scoped, 'settings:write', 'web')).toBe(false)
    expect(canInGroup(scoped, 'settings:read', 'games')).toBe(false)
    expect(
      canInGroup(principal([{ scope: { all: true }, actions: ['*'] }]), 'settings:write', 'x'),
    ).toBe(true)
    expect(canInGroup(null, 'settings:write', 'games')).toBe(false)
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

describe('visibleSettingsSections', () => {
  test('a repository reader sees only the Audit log', () => {
    const reader = principal([{ scope: { groups: ['shop'] }, actions: ['repos:read'] }])
    expect(visibleSettingsSections(reader)).toEqual(['audit'])
  })

  test('People needs users:read or settings:read, System a global settings:read; Analyzers and Policies any settings:read', () => {
    expect(
      visibleSettingsSections(
        principal([{ scope: { repos: ['w:x/**'] }, actions: ['users:read'] }]),
      ),
    ).toEqual(['people'])
    expect(
      visibleSettingsSections(
        principal([{ scope: { groups: ['a'] }, actions: ['settings:read'] }]),
      ),
    ).toEqual(['people', 'ai', 'integrations', 'analyzers', 'policies'])
    expect(
      visibleSettingsSections(principal([{ scope: { all: true }, actions: ['settings:read'] }])),
    ).toEqual(['people', 'ai', 'integrations', 'analyzers', 'policies', 'system'])
    expect(
      visibleSettingsSections(principal([{ scope: { all: true }, actions: ['credentials:read'] }])),
    ).toEqual(['ai', 'integrations'])
  })

  test('the whole audit log needs a global audit:read', () => {
    expect(
      visibleSettingsSections(principal([{ scope: { all: true }, actions: ['audit:read'] }])),
    ).toEqual(['audit'])
    expect(
      visibleSettingsSections(principal([{ scope: { groups: ['a'] }, actions: ['audit:read'] }])),
    ).toEqual([])
  })

  test('admins see every section, nobody without a principal', () => {
    expect(visibleSettingsSections(principal([{ scope: { all: true }, actions: ['*'] }]))).toEqual([
      'people',
      'ai',
      'integrations',
      'analyzers',
      'policies',
      'system',
      'audit',
    ])
    expect(visibleSettingsSections(null)).toEqual([])
    expect(visibleSettingsSections(principal([]))).toEqual([])
  })
})

describe('roleLabel', () => {
  test('names the People preset, Custom or No access', () => {
    expect(roleLabel([])).toBe('No access')
    expect(roleLabel([{ scope: { all: true }, actions: ['*'] }])).toBe('Admin')
    expect(roleLabel([{ scope: { groups: ['a'] }, actions: ['*'] }])).toBe('Custom')
    expect(roleLabel(grantsForRole('developer', { groups: ['a'] }))).toBe('Developer')
    expect(roleLabel(grantsForRole('maintainer', { groups: ['a'] }))).toBe('Maintainer')
    expect(roleLabel(grantsForRole('viewer', { all: true }))).toBe('Viewer')
    expect(
      roleLabel([
        { scope: { groups: ['a'] }, actions: ['repos:read', 'analyses:read'] },
        { scope: { all: true }, actions: ['audit:read'] },
      ]),
    ).toBe('Custom')
  })

  test('says the same as People for every preset', () => {
    for (const id of rolePresetIds)
      expect(roleLabel(grantsForRole(id, { groups: ['a'] }))).toBe(
        roleNames[roleOf(grantsForRole(id, { groups: ['a'] })).role],
      )
  })
})

describe('actionLabels', () => {
  test('labels every action and nothing else', () => {
    expect(Object.keys(actionLabels).toSorted()).toEqual(actions.toSorted())
    expect(actions).not.toContain('audits:allowlist' as never)
    for (const action of actions) expect(actionLabels[action].length).toBeGreaterThan(0)
  })
})
