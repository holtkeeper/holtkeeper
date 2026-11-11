import { expect, test } from 'bun:test'

import type { SettingDefinitionView } from '@holtkeeper/api'

import {
  definitionsOf,
  pageSettingKeys,
  parseSettingsTab,
  settingHome,
  settingsTabIds,
  settingsTabs,
  tabDefinitions,
} from './settings-tabs.ts'

const definition = (key: string): SettingDefinitionView => ({
  key,
  label: key,
  description: '',
  section: 'Any',
  secret: false,
  schema: {},
})

const all = [
  'analyzers.widget',
  'llm.budget',
  'agent.tools',
  'llm.provider',
  'polling',
  'analyzers.coverage',
  'some.plugin',
  'mergeRequests.policies',
  'commits.conventions',
  'access.crossTeam',
  'tasks.write',
].map(definition)

test('each tab lists its own settings in its order, skipping ones the server lacks', () => {
  expect(tabDefinitions(all, 'ai').map((d) => d.key)).toEqual([
    'llm.provider',
    'llm.budget',
    'agent.tools',
  ])
  expect(tabDefinitions(all, 'access').map((d) => d.key)).toEqual(['access.crossTeam'])
  expect(tabDefinitions(all, 'integrations')).toEqual([])
})

test('System also takes every setting no page or tab claims', () => {
  expect(tabDefinitions(all, 'system').map((d) => d.key)).toEqual([
    'polling',
    'analyzers.widget',
    'some.plugin',
  ])
})

test('write tasks have their own System section, not the generic list', () => {
  expect(settingHome('tasks.write')).toEqual({ tab: 'system' })
  expect(tabDefinitions(all, 'system').map((d) => d.key)).not.toContain('tasks.write')
})

test('analyzer options and policies live on the pages that own them', () => {
  expect(settingHome('analyzers.coverage')).toEqual({ page: 'coverage' })
  expect(settingHome('audit.allowlist')).toEqual({ page: 'audits' })
  expect(settingHome('commits.conventions')).toEqual({ page: 'knowledge' })
  expect(settingHome('assets.policy')).toEqual({ page: 'knowledge' })
  expect(settingHome('mergeRequests.policies')).toEqual({ page: 'automation' })
  expect(settingHome('llm.budget')).toEqual({ tab: 'ai' })
  expect(settingHome('analyzers.widget')).toBeUndefined()
})

test('no key has two homes', () => {
  const keys = [
    ...Object.values(pageSettingKeys).flat(),
    ...settingsTabIds.flatMap((tab) => settingsTabs[tab].keys),
  ]
  expect(new Set(keys).size).toBe(keys.length)
})

test('reads the tab parameter and picks definitions by key', () => {
  expect(parseSettingsTab('system')).toBe('system')
  expect(parseSettingsTab('analyzers')).toBeUndefined()
  expect(parseSettingsTab(undefined)).toBeUndefined()
  expect(definitionsOf(all, ['polling', 'missing', 'llm.budget']).map((d) => d.key)).toEqual([
    'polling',
    'llm.budget',
  ])
})
