import { expect, test } from 'bun:test'

import type { SettingDefinitionView } from '@holtkeeper/api'

import {
  definitionsOf,
  knowledgeSettingsLink,
  pageSettingKeys,
  parseSettingsSearch,
  parseSettingsSection,
  sectionDefinitions,
  settingHome,
  settingsPageHomes,
  settingsSectionIds,
  settingsSections,
} from './settings-sections.ts'

const definition = (key: string): SettingDefinitionView => ({
  key,
  label: key,
  description: '',
  section: 'Any',
  secret: false,
  default: null,
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

test('the sections are People, AI, Integrations, Analyzers, Policies, System and Audit log', () => {
  expect(settingsSectionIds.map((id) => settingsSections[id].label)).toEqual([
    'People & access',
    'AI',
    'Integrations',
    'Analyzers',
    'Policies',
    'System',
    'Audit log',
  ])
})

const sharedKeys = (section: 'analyzers' | 'policies') =>
  sectionDefinitions(
    [
      ...all,
      ...[
        'analyzers.licenses',
        'analyzers.tracker',
        'audit.allowlist',
        'analyzers.review',
        'analyzers.guide',
        'knowledge.autoAccept',
        'guide.autoAccept',
        'learnings.autoAccept',
        'repo.tests',
        'repo.analyzers',
      ].map(definition),
    ],
    section,
  ).map((d) => d.key)

test('Analyzers and Policies show keys their pages keep as home', () => {
  expect(sharedKeys('analyzers')).toEqual([
    'analyzers.widget',
    'analyzers.coverage',
    'analyzers.review',
    'analyzers.guide',
  ])
  expect(sharedKeys('policies')).toEqual([
    'knowledge.autoAccept',
    'learnings.autoAccept',
    'guide.autoAccept',
    'repo.analyzers',
    'commits.conventions',
    'analyzers.licenses',
    'audit.allowlist',
    'repo.tests',
  ])
  expect(settingHome('analyzers.coverage')).toEqual({ page: 'coverage' })
  expect(settingHome('repo.tests')).toEqual({ page: 'coverage' })
  expect(settingHome('repo.analyzers')).toEqual({ section: 'policies' })
  expect(settingHome('mergeRequests.comments')).toEqual({ section: 'policies' })
  expect(settingHome('audit.allowlistPolicy')).toEqual({ page: 'audits' })
  expect(settingHome('analyzers.licenses')).toEqual({ page: 'licenses' })
})

test('each section lists its own settings in its order, skipping ones the server lacks', () => {
  expect(sectionDefinitions(all, 'ai').map((d) => d.key)).toEqual([
    'llm.provider',
    'llm.budget',
    'agent.tools',
  ])
  expect(sectionDefinitions(all, 'people').map((d) => d.key)).toEqual(['access.crossTeam'])
  expect(sectionDefinitions(all, 'integrations')).toEqual([])
  expect(sectionDefinitions(all, 'audit')).toEqual([])
})

test('System also takes every setting no page or section claims', () => {
  expect(sectionDefinitions(all, 'system').map((d) => d.key)).toEqual([
    'polling',
    'analyzers.widget',
    'some.plugin',
  ])
  expect(settingHome('analyzers.widget')).toEqual({ section: 'system' })
})

test('write tasks are switched on the Tasks page, not in Settings', () => {
  expect(settingHome('tasks.write')).toEqual({ page: 'tasks' })
  expect(sectionDefinitions(all, 'system').map((d) => d.key)).not.toContain('tasks.write')
  expect(settingsPageHomes.tasks.to).toBe('/ops/tasks')
})

test('analyzer options and policies live on the pages that own them', () => {
  expect(settingHome('analyzers.coverage')).toEqual({ page: 'coverage' })
  expect(settingHome('audit.allowlist')).toEqual({ page: 'audits' })
  expect(settingHome('commits.conventions')).toEqual({ page: 'knowledge' })
  expect(settingHome('assets.policy')).toEqual({ page: 'knowledge' })
  expect(settingHome('knowledge.autoAccept')).toEqual({ section: 'policies' })
  expect(settingHome('analyzers.review')).toEqual({ page: 'reviews' })
  expect(settingHome('analyzers.guide')).toEqual({ page: 'knowledge' })
  expect(settingsPageHomes.reviews.to).toBe('/quality/reviews')
  expect(settingHome('mergeRequests.policies')).toEqual({ page: 'automation' })
  expect(settingHome('llm.budget')).toEqual({ section: 'ai' })
  expect(settingHome('repo.freeze')).toEqual({ section: 'people' })
})

test('no key has two homes', () => {
  const keys = [
    ...Object.values(pageSettingKeys).flat(),
    ...settingsSectionIds.flatMap((section) => settingsSections[section].keys),
  ]
  expect(new Set(keys).size).toBe(keys.length)
})

test('reads the section parameter and picks definitions by key', () => {
  expect(parseSettingsSection('system')).toBe('system')
  expect(parseSettingsSection('audit')).toBe('audit')
  expect(parseSettingsSection('access')).toBeUndefined()
  expect(parseSettingsSection(undefined)).toBeUndefined()
  expect(definitionsOf(all, ['polling', 'missing', 'llm.budget']).map((d) => d.key)).toEqual([
    'polling',
    'llm.budget',
  ])
})

test('Knowledge configures the Guide and learnings analyzers or the auto-accept policy', () => {
  expect(knowledgeSettingsLink('guide')).toEqual({
    to: '/settings/$section',
    params: { section: 'analyzers' },
    search: { item: 'guide' },
  })
  expect(knowledgeSettingsLink('learnings')).toMatchObject({
    params: { section: 'analyzers' },
    search: { item: 'review' },
  })
  expect(knowledgeSettingsLink('notes')).toEqual({
    to: '/settings/$section',
    params: { section: 'policies' },
    hash: 'setting-knowledge.autoAccept',
  })
})

test('reads the sheet deep link of a section', () => {
  expect(parseSettingsSearch({ item: 'u-1', tab: 'teams' })).toEqual({ item: 'u-1', tab: 'teams' })
  expect(parseSettingsSearch({ item: '', tab: 3, other: 'x' })).toEqual({})
  expect(parseSettingsSearch({ repo: 'work:acme/widget-kit' })).toEqual({
    repo: 'work:acme/widget-kit',
  })
})
