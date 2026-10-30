import { describe, expect, test } from 'bun:test'

import type { Scope } from '@holtkeeper/access'
import type { SettingEntry } from '@holtkeeper/store'

import { builtinSettings } from './definitions.ts'
import { resolveSetting, resolveSettings } from './resolve.ts'

const entry = (
  id: string,
  scope: Scope,
  value: unknown,
  updatedAt = '2026-10-01',
): SettingEntry => ({
  id,
  key: 'llm.model',
  scope,
  value,
  secret: false,
  updatedAt,
})

const repo = { forge: 'work', path: 'games/app-x', groups: ['games'] }

describe('resolveSetting', () => {
  const entries = [
    entry('global', { all: true }, 'claude-sonnet-5-5'),
    entry('group', { groups: ['games'] }, 'claude-opus-5-5'),
    entry('glob', { repos: ['games/app-*'] }, 'claude-haiku-5-5'),
  ]

  test('picks the most specific covering scope', () => {
    expect(resolveSetting(entries, 'llm.model', repo)?.id).toBe('glob')
    expect(resolveSetting(entries, 'llm.model', { ...repo, path: 'games/adventure' })?.id).toBe(
      'group',
    )
    expect(
      resolveSetting(entries, 'llm.model', { forge: 'work', path: 'tools/x', groups: [] })?.id,
    ).toBe('global')
    expect(resolveSetting(entries, 'audit.fix', repo)).toBeUndefined()
  })

  test('exact paths beat globs and newer entries break ties', () => {
    const more = [
      ...entries,
      entry('exact', { repos: ['games/app-x'] }, 'x'),
      entry('glob2', { repos: ['games/*'] }, 'y', '2026-10-05'),
    ]
    expect(resolveSetting(more, 'llm.model', repo)?.id).toBe('exact')
    expect(
      resolveSetting(
        more.filter((e) => e.id !== 'exact'),
        'llm.model',
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
      ['llm.model', 'glob'],
      ['audit.fix', 'fix'],
    ])
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
