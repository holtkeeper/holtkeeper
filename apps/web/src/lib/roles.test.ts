import { describe, expect, test } from 'bun:test'

import type { Grant } from '@holtkeeper/api'

import { abilityChanges, grantsForRole, roleOf, rolePresets, sameAccess } from './roles.ts'

const developer = [...rolePresets.developer.actions]

describe('roleOf', () => {
  test('reads presets with the scope they apply to', () => {
    expect(roleOf([])).toEqual({ role: 'none' })
    expect(roleOf([{ scope: { all: true }, actions: ['*'] }])).toEqual({
      role: 'admin',
      scope: { all: true },
    })
    expect(roleOf(grantsForRole('viewer', { groups: ['widgets'] }))).toEqual({
      role: 'viewer',
      scope: { groups: ['widgets'] },
    })
  })

  test('ignores action order and merges the scopes of several preset grants', () => {
    const grants: Grant[] = [
      { scope: { groups: ['widgets'] }, actions: developer.toReversed() },
      { scope: { repos: ['acme/widget-kit'] }, actions: developer },
    ]
    expect(roleOf(grants)).toEqual({
      role: 'developer',
      scope: { groups: ['widgets'], repos: ['acme/widget-kit'] },
    })
  })

  test('grants matching no preset stay custom', () => {
    expect(roleOf([{ scope: { groups: ['widgets'] }, actions: ['repos:read'] }])).toEqual({
      role: 'custom',
    })
    expect(
      roleOf([{ scope: { groups: ['widgets'] }, actions: [...developer, 'credentials:read'] }]),
    ).toEqual({ role: 'custom' })
    expect(roleOf([{ scope: { groups: ['widgets'] }, actions: ['*'] }])).toEqual({
      role: 'custom',
    })
    expect(
      roleOf([
        { scope: { all: true }, actions: ['*'] },
        { scope: { groups: ['widgets'] }, actions: ['repos:read'] },
      ]),
    ).toEqual({ role: 'admin', scope: { all: true } })
    expect(
      roleOf([
        { scope: { groups: ['widgets'] }, actions: developer },
        { scope: { groups: ['gadgets'] }, actions: [...rolePresets.viewer.actions] },
      ]),
    ).toEqual({ role: 'custom' })
  })
})

describe('grantsForRole', () => {
  test('admin always covers everything; other presets keep the scope', () => {
    expect(grantsForRole('admin', { groups: ['widgets'] })).toEqual([
      { scope: { all: true }, actions: ['*'] },
    ])
    expect(grantsForRole('maintainer', { groups: ['widgets', 'widgets'], repos: [] })).toEqual([
      { scope: { groups: ['widgets'] }, actions: [...rolePresets.maintainer.actions] },
    ])
  })

  test('presets nest: each allows everything the narrower one does', () => {
    const { viewer, developer: dev, maintainer } = rolePresets
    expect(viewer.actions.every((action) => dev.actions.includes(action))).toBe(true)
    expect(dev.actions.every((action) => maintainer.actions.includes(action))).toBe(true)
  })
})

describe('abilityChanges', () => {
  test('marks what a role change gains and loses', () => {
    const scope = { groups: ['widgets'] }
    const changes = abilityChanges(
      grantsForRole('developer', scope),
      grantsForRole('maintainer', scope),
    )
    const state = (label: string) => changes.find((change) => change.ability.label === label)?.state
    expect(state('Run release steps')).toBe('gains')
    expect(state('Run analyzers and audits')).toBe('allowed')
    expect(state('Invite and edit people')).toBe('no')
    const down = abilityChanges(grantsForRole('maintainer', scope), grantsForRole('viewer', scope))
    expect(down.find((change) => change.ability.label === 'Run release steps')?.state).toBe('loses')
  })
})

describe('sameAccess', () => {
  test('reads a split preset with reordered actions as the preset it matches', () => {
    const split = [
      { scope: { groups: ['widgets'] }, actions: rolePresets.viewer.actions.toReversed() },
      { scope: { groups: ['gadgets'] }, actions: [...rolePresets.viewer.actions] },
    ]
    expect(sameAccess(grantsForRole('viewer', { groups: ['gadgets', 'widgets'] }), split)).toBe(
      true,
    )
    expect(sameAccess(grantsForRole('viewer', { groups: ['widgets'] }), split)).toBe(false)
    expect(sameAccess(grantsForRole('developer', { groups: ['gadgets', 'widgets'] }), split)).toBe(
      false,
    )
  })

  test('custom grants match only themselves', () => {
    const custom = [{ scope: { groups: ['widgets'] }, actions: ['repos:read' as const] }]
    expect(sameAccess(custom, [...custom])).toBe(true)
    expect(sameAccess(custom, [{ ...custom[0]!, scope: { groups: ['gadgets'] } }])).toBe(false)
  })
})
