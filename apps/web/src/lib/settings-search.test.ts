import { expect, test } from 'bun:test'

import type { Principal, SettingDefinitionView } from '@holtkeeper/api'

import { visibleSettingsSections } from './access.ts'
import { groupSettingsResults, searchSettings, settingsIndex } from './settings-search.ts'
import { settingsSectionIds } from './settings-sections.ts'

const definition = (
  key: string,
  label: string,
  section: string,
  description = '',
): SettingDefinitionView => ({
  key,
  label,
  description,
  section,
  secret: false,
  schema: {},
  default: null,
})

const definitions = [
  definition('llm.budget', 'AI budget', 'AI', 'Weekly spend cap for agents'),
  definition('llm.provider', 'AI provider', 'AI'),
  definition('access.crossTeam', 'Reach', 'Access', "What other teams' repositories people read"),
  definition('analyzers.coverage', 'Coverage', 'Analyzers', 'Where coverage reports are'),
  definition('tasks.write', 'Write tasks', 'Agents'),
  definition('polling', 'Polling', 'System'),
  definition('analyzers.widget', 'Widget analyzer', 'Analyzers'),
  definition('analyzers.review', 'Code review', 'Analyzers', 'Options for the review analyzer'),
  definition('analyzers.guide', 'Guide', 'Analyzers', 'Options for the guide analyzer'),
  definition(
    'knowledge.autoAccept',
    'Auto-accept agent knowledge',
    'Knowledge',
    'Kinds of knowledge entries agents may add without review',
  ),
]

const everything = settingsIndex(definitions, settingsSectionIds)

test('every setting key is findable by its key and its label', () => {
  for (const each of definitions) {
    expect(searchSettings(everything, each.key).map((e) => e.key)).toContain(each.key)
    expect(searchSettings(everything, each.label).map((e) => e.key)).toContain(each.key)
  }
})

test('settings edited on other pages say where they live and link there', () => {
  const [coverage] = searchSettings(everything, 'analyzers.coverage')
  expect(coverage).toMatchObject({ where: 'Quality › Coverage', link: { to: '/quality/coverage' } })
  const [tasks] = searchSettings(everything, 'tasks.write')
  expect(tasks).toMatchObject({ where: 'Ops › Tasks', link: { to: '/ops/tasks' } })
})

test('knowledge and review settings are found where they are edited, not in System', () => {
  const [accept] = searchSettings(everything, 'auto-accept')
  expect(accept).toMatchObject({
    key: 'knowledge.autoAccept',
    where: 'Settings › Policies',
    link: {
      to: '/settings/$section',
      params: { section: 'policies' },
      hash: 'setting-knowledge.autoAccept',
    },
  })
  expect(searchSettings(everything, 'without review').map((e) => e.id)).toEqual([
    'section:policies',
    'setting:knowledge.autoAccept',
  ])
  const [review] = searchSettings(everything, 'analyzers.review')
  expect(review).toMatchObject({ where: 'Quality › Reviews', link: { to: '/quality/reviews' } })
  const [guide] = searchSettings(everything, 'analyzers.guide')
  expect(guide).toMatchObject({ where: 'Knowledge › Guide', link: { to: '/knowledge/guide' } })
})

test('settings in a section link to their entries there; unclaimed ones live in System', () => {
  const [budget] = searchSettings(everything, 'budget')
  expect(budget).toMatchObject({
    key: 'llm.budget',
    where: 'Settings › AI',
    link: { to: '/settings/$section', params: { section: 'ai' }, hash: 'setting-llm.budget' },
  })
  const [widget] = searchSettings(everything, 'widget')
  expect(widget?.link).toMatchObject({ params: { section: 'system' } })
})

test('sections are entries too and come first on a tie', () => {
  const results = searchSettings(everything, 'ai')
  expect(results[0]).toMatchObject({ id: 'section:ai', kind: 'section', group: 'Settings' })
  expect(results.map((e) => e.key)).toEqual(expect.arrayContaining(['llm.budget', 'llm.provider']))
  expect(searchSettings(everything, 'audit log')[0]?.id).toBe('section:audit')
})

test('only sections the viewer can open, and their settings, are indexed', () => {
  const auditOnly = settingsIndex(definitions, ['audit'])
  expect(auditOnly.filter((e) => e.kind === 'section').map((e) => e.id)).toEqual(['section:audit'])
  expect(searchSettings(auditOnly, 'budget')).toEqual([])
  expect(searchSettings(auditOnly, 'coverage').map((e) => e.key)).toEqual(['analyzers.coverage'])
})

test('every word must match, matches in labels rank before descriptions', () => {
  expect(searchSettings(everything, '')).toEqual([])
  expect(searchSettings(everything, '   ')).toEqual([])
  expect(searchSettings(everything, 'spend cap').map((e) => e.key)).toEqual(['llm.budget'])
  expect(searchSettings(everything, 'nothing like this')).toEqual([])
  expect(searchSettings(everything, 'cov').map((e) => e.key)).toEqual(['analyzers.coverage'])
  expect(searchSettings(everything, 'repositories')[0]?.id).toBe('section:people')
  expect(searchSettings(everything, 'polling system').map((e) => e.key)).toEqual(['polling'])
})

test('results group by the definition section in order of appearance', () => {
  const grouped = groupSettingsResults(searchSettings(everything, 'a'))
  expect(grouped[0]?.group).toBe('Settings')
  expect(new Set(grouped.map((g) => g.group)).size).toBe(grouped.length)
  expect(grouped.find((g) => g.group === 'AI')?.entries.map((e) => e.key)).toEqual([
    'llm.budget',
    'llm.provider',
  ])
})

test('a global settings reader without users:read finds every key', () => {
  const reader: Principal = {
    id: 'settings-reader',
    name: 'Settings reader',
    provider: 'users',
    grants: [{ scope: { all: true }, actions: ['settings:read', 'settings:write'] }],
  }
  const index = settingsIndex(definitions, visibleSettingsSections(reader))
  for (const each of definitions)
    expect(searchSettings(index, each.key).map((e) => e.key)).toContain(each.key)
})
