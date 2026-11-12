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
  test('the schema needs a reason and accepts an optional end with an offset', () => {
    expect(repoFreeze.schema.safeParse({ reason: 'Code freeze' }).success).toBe(true)
    expect(
      repoFreeze.schema.safeParse({ reason: 'Code freeze', until: '2026-12-01T00:00:00+02:00' })
        .success,
    ).toBe(true)
    expect(repoFreeze.schema.safeParse({ reason: '  ' }).success).toBe(false)
    expect(repoFreeze.schema.safeParse(true).success).toBe(false)
    expect(repoFreeze.schema.safeParse({ reason: 'x', until: 'next week' }).success).toBe(false)
  })

  test('a freeze counts only before its end', () => {
    expect(activeFreeze({ reason: 'Vendored' }, now)).toEqual({ reason: 'Vendored' })
    expect(activeFreeze({ reason: 'Release', until: '2026-11-12T12:00:01.000Z' }, now)).toEqual({
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
    expect(resolveRepoFreeze([group, expired], repo, now)?.entry.id).toBe('g')
    expect(resolveRepoFreeze([expired], repo, now)).toBeUndefined()
    expect(resolveRepoFreeze([expired], repo, new Date('2026-11-09T00:00:00.000Z'))).toEqual({
      entry: expired,
      freeze: { reason: 'Hotfix window', until: '2026-11-10T00:00:00.000Z' },
    })
    expect(resolveRepoFreeze([group], { ...repo, groups: ['other'] }, now)).toBeUndefined()
  })
})
