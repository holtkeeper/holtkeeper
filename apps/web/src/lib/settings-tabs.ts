import type { SettingDefinitionView } from '@holtkeeper/api'

import { automationSettingKeys } from './automation-flow.ts'
import { sectionPolicies } from './guide.ts'
import { knowledgeSettingKeys } from './knowledge.ts'

/** The tabs of `/settings` in display order; also the page's `tab` search parameter. */
export const settingsTabIds = ['ai', 'access', 'integrations', 'system'] as const

export type SettingsTabId = (typeof settingsTabIds)[number]

/** Label, summary and the setting keys each Settings tab edits, in display order. */
export const settingsTabs: Readonly<
  Record<SettingsTabId, { label: string; description: string; keys: readonly string[] }>
> = {
  ai: {
    label: 'AI',
    description: 'The provider agents use, the weekly budget and what agents spend',
    keys: ['llm.provider', 'llm.budget', 'agent.tools'],
  },
  access: {
    label: 'Access',
    description: 'People, their grants, what other teams may read and MCP tokens',
    keys: ['access.crossTeam', 'repo.readOnly'],
  },
  integrations: {
    label: 'Integrations',
    description: 'Forges, credentials, trackers and outgoing webhooks',
    keys: ['trackers', 'analyzers.tracker', 'releases.notify', 'limits.credentials'],
  },
  system: {
    label: 'System',
    description: 'Storage, database, caches, the library index, write tasks and background limits',
    keys: ['libraries', 'polling', 'toolchain', 'freshness.sweep'],
  },
}

/** Keys of a tab shown under Advanced: rarely changed, their defaults are constants. */
export const advancedSettingKeys: ReadonlySet<string> = new Set(['agent.tools'])

/** The `tab` search parameter as a Settings tab, `undefined` for anything else. */
export const parseSettingsTab = (value: unknown): SettingsTabId | undefined =>
  settingsTabIds.find((id) => id === value)

const settingsPages = [
  'bundles',
  'dependencies',
  'public-api',
  'stack',
  'audits',
  'licenses',
  'coverage',
  'branches',
  'ci',
  'releases',
  'assets',
  'knowledge',
  'automation',
] as const

/** Pages outside Settings that edit settings, each through a drawer or a section of its own. */
type SettingsPage = (typeof settingsPages)[number]

/** The settings a page owns: analyzer options in its drawer, policies in its own sections. */
export const pageSettingKeys: Readonly<Record<SettingsPage, readonly string[]>> = {
  bundles: ['analyzers.bundle'],
  dependencies: ['analyzers.depgraph', 'analyzers.renovate'],
  'public-api': ['analyzers.api-surface', 'analyzers.usages'],
  stack: ['analyzers.stack', 'analyzers.browserslist'],
  audits: ['analyzers.audit', 'audit.fix', 'audit.upgrade', 'audit.allowlist'],
  licenses: ['analyzers.licenses'],
  coverage: ['analyzers.coverage'],
  branches: ['analyzers.branches'],
  ci: ['analyzers.ci-jobs'],
  releases: ['releases'],
  assets: ['analyzers.assets'],
  knowledge: [...knowledgeSettingKeys, ...Object.values(sectionPolicies)],
  automation: [...automationSettingKeys],
}

type SettingHome = { tab: SettingsTabId } | { page: SettingsPage }

/** Settings a section of their own edits on a Settings tab, outside the tab's settings list. */
const sectionSettingKeys: Readonly<Record<string, SettingsTabId>> = {
  'tasks.write': 'system',
}

const homes = new Map<string, SettingHome>([
  ...settingsPages.flatMap((page) => pageSettingKeys[page].map((key) => [key, { page }] as const)),
  ...Object.entries(sectionSettingKeys).map(([key, tab]) => [key, { tab }] as const),
  ...settingsTabIds.flatMap((tab) => settingsTabs[tab].keys.map((key) => [key, { tab }] as const)),
])

/** Where a setting is edited: a Settings tab, another page, or nowhere yet (`undefined`). */
export const settingHome = (key: string): SettingHome | undefined => homes.get(key)

/**
 * The definitions a Settings tab shows, in the tab's order. System also takes every setting no
 * page or tab claims (plugin settings, analyzers without a page), so nothing becomes uneditable.
 */
export function tabDefinitions(
  definitions: readonly SettingDefinitionView[],
  tab: SettingsTabId,
): SettingDefinitionView[] {
  const own = settingsTabs[tab].keys.flatMap((key) => definitions.filter((d) => d.key === key))
  if (tab !== 'system') return own
  return [...own, ...definitions.filter((d) => !homes.has(d.key))]
}

/** The definitions of `keys` in that order, skipping keys the server does not define. */
export const definitionsOf = (
  definitions: readonly SettingDefinitionView[],
  keys: readonly string[],
): SettingDefinitionView[] => keys.flatMap((key) => definitions.filter((d) => d.key === key))
