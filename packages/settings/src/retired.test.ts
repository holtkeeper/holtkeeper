import { expect, test } from 'bun:test'

import type { SettingEntry } from '@holtkeeper/store'

import { builtinSettings } from './definitions.ts'
import {
  resolveGlobalSetting,
  resolveSetting,
  resolveSettings,
  settingCascades,
} from './resolve.ts'
import { isRetiredSetting, retiredSettingKeys } from './retired.ts'

const entry = (id: string, key: string, value: unknown): SettingEntry => ({
  id,
  key,
  scope: { all: true },
  value,
  secret: false,
  updatedAt: '2026-10-01',
})

const repo = { forge: 'work', path: 'shapes/widget', groups: ['shapes'] }

test('the resolver ignores entries of retired keys, even with values no schema accepts', () => {
  const entries = [
    entry('old-model', 'llm.model', { anything: ['goes'] }),
    entry('old-analyzer', 'analyzers.fleet', 42),
    entry('live', 'audit.upgrade', 'minor'),
  ]
  expect(resolveSetting(entries, 'llm.model', repo)).toBeUndefined()
  expect(resolveGlobalSetting(entries, 'analyzers.fleet')).toBeUndefined()
  expect([...resolveSettings(entries, repo).keys()]).toEqual(['audit.upgrade'])
  expect([...settingCascades(entries, repo).keys()]).toEqual(['audit.upgrade'])
})

test('no built-in setting is retired', () => {
  expect(builtinSettings.filter((definition) => isRetiredSetting(definition.key))).toEqual([])
  expect(isRetiredSetting('llm.models')).toBe(true)
  expect(isRetiredSetting('llm.budget')).toBe(false)
  expect(retiredSettingKeys.size).toBeGreaterThan(0)
})
