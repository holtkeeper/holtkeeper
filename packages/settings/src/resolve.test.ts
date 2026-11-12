import { describe, expect, test } from 'bun:test'

import type { Scope } from '@holtkeeper/access'
import type { SettingEntry } from '@holtkeeper/store'

import { builtinSettings } from './definitions.ts'
import {
  effectiveSettings,
  resolveGlobalSetting,
  resolveSetting,
  resolveSettings,
  settingCascade,
  settingCascades,
} from './resolve.ts'

const entry = (
  id: string,
  scope: Scope,
  value: unknown,
  updatedAt = '2026-10-01',
): SettingEntry => ({
  id,
  key: 'audit.upgrade',
  scope,
  value,
  secret: false,
  updatedAt,
})

const repo = { forge: 'work', path: 'games/app-x', groups: ['games'] }

describe('resolveSetting', () => {
  const entries = [
    entry('global', { all: true }, 'major'),
    entry('group', { groups: ['games'] }, 'minor'),
    entry('glob', { repos: ['games/app-*'] }, 'patch'),
  ]

  test('picks the most specific covering scope', () => {
    expect(resolveSetting(entries, 'audit.upgrade', repo)?.id).toBe('glob')
    expect(resolveSetting(entries, 'audit.upgrade', { ...repo, path: 'games/adventure' })?.id).toBe(
      'group',
    )
    expect(
      resolveSetting(entries, 'audit.upgrade', { forge: 'work', path: 'tools/x', groups: [] })?.id,
    ).toBe('global')
    expect(resolveSetting(entries, 'audit.fix', repo)).toBeUndefined()
  })

  test('exact paths beat globs and newer entries break ties', () => {
    const more = [
      ...entries,
      entry('exact', { repos: ['games/app-x'] }, 'x'),
      entry('glob2', { repos: ['games/*'] }, 'y', '2026-10-05'),
    ]
    expect(resolveSetting(more, 'audit.upgrade', repo)?.id).toBe('exact')
    expect(
      resolveSetting(
        more.filter((e) => e.id !== 'exact'),
        'audit.upgrade',
        repo,
      )?.id,
    ).toBe('glob2')
  })

  test('resolves every key at once', () => {
    const all = resolveSettings(
      [...entries, { ...entry('fix', { all: true }, true), key: 'audit.fix' }],
      repo,
    )
    expect([...all].map(([key, value]) => [key, value.id])).toEqual([
      ['audit.upgrade', 'glob'],
      ['audit.fix', 'fix'],
    ])
  })
})

describe('settingCascade', () => {
  const entries = [
    entry('global', { all: true }, 'major'),
    entry('group', { groups: ['games'] }, 'minor'),
    entry('glob', { repos: ['games/app-*'] }, 'patch'),
    entry('other', { groups: ['tools'] }, 'x'),
  ]

  test('lists covering entries from the one that applies to the broadest', () => {
    expect(settingCascade(entries, 'audit.upgrade', repo).map((e) => e.id)).toEqual([
      'glob',
      'group',
      'global',
    ])
    expect(settingCascade(entries, 'audit.fix', repo)).toEqual([])
  })

  test('cascades of every key with a covering entry', () => {
    const all = settingCascades(
      [...entries, { ...entry('fix', { groups: ['tools'] }, true), key: 'audit.fix' }],
      repo,
    )
    expect([...all].map(([key, list]) => [key, list.map((e) => e.id)])).toEqual([
      ['audit.upgrade', ['glob', 'group', 'global']],
    ])
  })
})

describe('resolveGlobalSetting', () => {
  test('takes the newest entry for everything and ignores narrower scopes', () => {
    const entries = [
      entry('old', { all: true }, 'major', '2026-09-01'),
      entry('new', { all: true }, 'minor', '2026-10-01'),
      entry('group', { groups: ['games'] }, 'patch', '2026-11-01'),
    ]
    expect(resolveGlobalSetting(entries, 'audit.upgrade')?.id).toBe('new')
    expect(resolveGlobalSetting(entries.slice(2), 'audit.upgrade')).toBeUndefined()
  })
})

describe('builtinSettings', () => {
  test('have unique keys and validate values', () => {
    const keys = builtinSettings.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
    const allowlist = builtinSettings.find((s) => s.key === 'audit.allowlist')
    expect(
      allowlist?.schema.safeParse([{ id: 'GHSA-1', reason: 'no SSR', when: { ssr: false } }])
        .success,
    ).toBe(true)
    expect(allowlist?.schema.safeParse([{ id: 'GHSA-1' }]).success).toBe(false)
  })
})

const at = (key: string, id: string, scope: Scope, value: unknown): SettingEntry => ({
  ...entry(id, scope, value),
  key,
})

describe('effectiveSettings', () => {
  const entries = [
    at('audit.upgrade', 'global', { all: true }, 'major'),
    at('audit.upgrade', 'group', { groups: ['games'] }, 'minor'),
    at('llm.provider', 'narrow', { groups: ['games'] }, 'Other'),
    at('llm.provider', 'everywhere', { all: true }, 'Main'),
    at('llm.model', 'retired', { all: true }, 'old'),
    at('acme.unknown', 'unknown', { all: true }, 1),
  ]
  const rows = effectiveSettings(builtinSettings, entries, repo)

  test('lists every live definition once, in definition order', () => {
    expect(rows.map((row) => row.definition.key)).toEqual(builtinSettings.map((d) => d.key))
  })

  test('gives the single winner and what it overrides', () => {
    const upgrade = rows.find((row) => row.definition.key === 'audit.upgrade')
    expect(upgrade?.entry?.id).toBe('group')
    expect(upgrade?.overridden.map((e) => e.id)).toEqual(['global'])
  })

  test('counts only entries for everything on global settings', () => {
    const provider = rows.find((row) => row.definition.key === 'llm.provider')
    expect(provider?.entry?.id).toBe('everywhere')
    expect(provider?.overridden).toEqual([])
  })

  test('leaves the entry out when the default applies', () => {
    const fix = rows.find((row) => row.definition.key === 'audit.fix')
    expect(fix?.entry).toBeUndefined()
    expect(fix?.definition.default).toBe(false)
  })
})
