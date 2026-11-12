import { describe, expect, test } from 'bun:test'

import type { SettingEntry } from '@holtkeeper/store'

import { repoFreeze } from './definitions.ts'
import { activeFreeze, resolveRepoFreeze } from './freeze.ts'

const now = new Date('2026-11-12T12:00:00.000Z')
const repo = { forge: 'acme', path: 'shapes/widget', groups: ['shapes'] }

const entry = (id: string, scope: SettingEntry['scope'], value: unknown): SettingEntry => ({
  id,
  key: 'repo.freeze',
  scope,
  value,
  secret: false,
  updatedAt: '2026-11-01T00:00:00.000Z',
})

describe('repo.freeze', () => {
  test('a freeze needs a reason, a lift does not, and an end needs an offset', () => {
    expect(repoFreeze.schema.safeParse({ reason: 'Code freeze' }).data).toEqual({
      frozen: true,
      reason: 'Code freeze',
    })
    expect(
      repoFreeze.schema.safeParse({ reason: 'Code freeze', until: '2026-12-01T00:00:00+02:00' })
        .success,
    ).toBe(true)
    expect(repoFreeze.schema.safeParse({ frozen: false }).success).toBe(true)
    expect(repoFreeze.schema.safeParse({ frozen: false, reason: 'Reviewed lib' }).success).toBe(
      true,
    )
    expect(repoFreeze.schema.safeParse({}).success).toBe(false)
    expect(repoFreeze.schema.safeParse({ frozen: true }).success).toBe(false)
    expect(repoFreeze.schema.safeParse({ reason: '  ' }).success).toBe(false)
    expect(repoFreeze.schema.safeParse({ frozen: false, reason: ' ' }).data).toEqual({
      frozen: false,
    })
    expect(repoFreeze.schema.safeParse(true).success).toBe(false)
    expect(repoFreeze.schema.safeParse({ reason: 'x', until: 'next week' }).success).toBe(false)
  })

  test('an entry counts only before its end', () => {
    expect(activeFreeze({ reason: 'Vendored' }, now)).toEqual({ frozen: true, reason: 'Vendored' })
    expect(activeFreeze({ reason: 'Release', until: '2026-11-12T12:00:01.000Z' }, now)).toEqual({
      frozen: true,
      reason: 'Release',
      until: '2026-11-12T12:00:01.000Z',
    })
    expect(
      activeFreeze({ reason: 'Release', until: '2026-11-12T12:00:00.000Z' }, now),
    ).toBeUndefined()
    expect(activeFreeze(true, now)).toBeUndefined()
  })

  test('an expired narrow entry is ignored and the broader one applies again', () => {
    const group = entry('g', { groups: ['shapes'] }, { reason: 'Team freeze' })
    const expired = entry(
      'r',
      { repos: ['shapes/widget'] },
      { reason: 'Hotfix window', until: '2026-11-10T00:00:00.000Z' },
    )
    expect(resolveRepoFreeze([group, expired], repo, now)).toEqual({
      frozen: true,
      reason: 'Team freeze',
      entry: group,
    })
    expect(resolveRepoFreeze([expired], repo, now)).toEqual({ frozen: false })
    expect(resolveRepoFreeze([expired], repo, new Date('2026-11-09T00:00:00.000Z'))).toEqual({
      frozen: true,
      reason: 'Hotfix window',
      until: '2026-11-10T00:00:00.000Z',
      entry: expired,
    })
    expect(resolveRepoFreeze([group], { ...repo, groups: ['other'] }, now)).toEqual({
      frozen: false,
    })
  })

  test('a narrower lift keeps its repository writable under a group freeze', () => {
    const group = entry('g', { groups: ['shapes'] }, { reason: 'Team freeze' })
    const lift = entry('r', { repos: ['shapes/widget'] }, { frozen: false, reason: 'Reviewed lib' })
    expect(resolveRepoFreeze([group, lift], repo, now)).toEqual({
      frozen: false,
      reason: 'Reviewed lib',
      entry: lift,
      lifted: true,
    })
    expect(resolveRepoFreeze([group, lift], { ...repo, path: 'shapes/gadget' }, now).frozen).toBe(
      true,
    )
  })

  test('an expired lift lets the group freeze apply again', () => {
    const group = entry('g', { groups: ['shapes'] }, { reason: 'Team freeze' })
    const lift = entry(
      'r',
      { repos: ['shapes/widget'] },
      { frozen: false, until: '2026-11-12T00:00:00.000Z' },
    )
    expect(resolveRepoFreeze([group, lift], repo, new Date('2026-11-11T00:00:00.000Z'))).toEqual({
      frozen: false,
      until: '2026-11-12T00:00:00.000Z',
      entry: lift,
      lifted: true,
    })
    expect(resolveRepoFreeze([group, lift], repo, now).entry).toBe(group)
  })

  test('a lift with no freeze in force above it lifts nothing', () => {
    const lift = entry('r', { repos: ['shapes/widget'] }, { frozen: false })
    const expired = entry(
      'g',
      { groups: ['shapes'] },
      { reason: 'Team freeze', until: '2026-11-01T00:00:00.000Z' },
    )
    const all = entry('a', { all: true }, { frozen: false })
    expect(resolveRepoFreeze([lift], repo, now)).toEqual({ frozen: false, entry: lift })
    expect(resolveRepoFreeze([lift, expired, all], repo, now)).toEqual({
      frozen: false,
      entry: lift,
    })
  })

  test('secret entries are skipped', () => {
    const group = entry('g', { groups: ['shapes'] }, { reason: 'Team freeze' })
    const sealed = {
      ...entry('r', { repos: ['shapes/widget'] }, { frozen: false }),
      secret: true,
    }
    expect(resolveRepoFreeze([group, sealed], repo, now).entry).toBe(group)
    expect(resolveRepoFreeze([sealed], repo, now)).toEqual({ frozen: false })
  })

  test('the editor starts a new entry frozen with the reason shown', () => {
    expect(repoFreeze.form?.parse(undefined)).toEqual({ frozen: true, reason: '' })
  })

  test('a narrower freeze still wins over a broader lift', () => {
    const all = entry('a', { all: true }, { frozen: false })
    const group = entry('g', { groups: ['shapes'] }, { reason: 'Team freeze' })
    expect(resolveRepoFreeze([all, group], repo, now).frozen).toBe(true)
  })
})
