import type { SettingDefinitionView } from '@holtkeeper/api'

import { automationSettingKeys } from './automation-flow.ts'
import { type KnowledgeTab, sectionPolicies } from './guide.ts'

/** The sections of Settings in display order; also the `$section` of `/settings/$section`. */
export const settingsSectionIds = [
  'people',
  'ai',
  'integrations',
  'analyzers',
  'policies',
  'system',
  'audit',
] as const

export type SettingsSectionId = (typeof settingsSectionIds)[number]

/**
 * Label, summary and the setting keys each Settings section is the home of, in display order.
 * Analyzers homes no key and Policies only the auto-accept policies (`knowledge.autoAccept`,
 * `learnings.autoAccept`, `guide.autoAccept`), `repo.analyzers` and `mergeRequests.comments`: otherwise they are a second way
 * into keys their pages own (see `sharedSectionKeys`).
 */
export const settingsSections: Readonly<
  Record<SettingsSectionId, { label: string; description: string; keys: readonly string[] }>
> = {
  people: {
    label: 'People & access',
    description:
      "Who can sign in, what each person may do, and what other teams' repositories people and agents read",
    keys: ['access.crossTeam', 'repo.freeze'],
  },
  ai: {
    label: 'AI',
    description: 'The provider agents use, the weekly budget and AI credentials',
    keys: ['llm.provider', 'llm.budget', 'agent.tools'],
  },
  integrations: {
    label: 'Integrations',
    description: 'Forges, credentials, trackers, outgoing webhooks, request limits and Slack',
    keys: [
      'trackers',
      'analyzers.tracker',
      'releases.notify',
      'limits.credentials',
      'slack.reviews',
      'releases.announce',
    ],
  },
  analyzers: {
    label: 'Analyzers',
    description: 'What each analyzer runs on, how it is doing and its options per scope',
    keys: [],
  },
  policies: {
    label: 'Policies',
    description:
      'License policy, the security allowlist, commit conventions, what agents may learn without review and other rules repositories are judged by',
    keys: [
      'knowledge.autoAccept',
      'learnings.autoAccept',
      'guide.autoAccept',
      'repo.analyzers',
      'mergeRequests.comments',
    ],
  },
  system: {
    label: 'System',
    description: 'Storage, database, caches, the library index and background limits',
    keys: ['libraries', 'polling', 'toolchain', 'freshness.sweep'],
  },
  audit: {
    label: 'Audit log',
    description: 'Who changed what, newest first',
    keys: [],
  },
}

const policyKeys: ReadonlySet<string> = new Set([
  'analyzers.licenses',
  'audit.allowlist',
  'audit.allowlistPolicy',
  'audit.fix',
  'audit.upgrade',
  'commits.conventions',
  'assets.policy',
  'analyzers.stack',
  'analyzers.testids',
  'repo.tests',
])

/**
 * Keys a section shows although a page is their home: Analyzers every `analyzers.<kind>` key no
 * Settings section homes (the License policy stays under Policies), Policies the policy keys. The
 * page keeps editing them too; `settingHome` still names the page.
 */
const sharedSectionKeys: Readonly<Partial<Record<SettingsSectionId, (key: string) => boolean>>> = {
  analyzers: (key) => key.startsWith('analyzers.') && !policyKeys.has(key) && !sectionHomed(key),
  policies: (key) => policyKeys.has(key),
}

/** Keys of a section shown under Advanced: rarely changed, their defaults are constants. */
export const advancedSettingKeys: ReadonlySet<string> = new Set(['agent.tools'])

/**
 * Search parameters of `/settings/$section`: `item` opens a record's sheet (a user, a credential,
 * an analyzer, a policy), `tab` picks a tab inside it or a sub-section of the page, and `repo`
 * (`forge:path`) starts the audit log filtered to that repository.
 */
export interface SettingsSearch {
  item?: string
  tab?: string
  repo?: string
}

const searchText = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

/** The known `SettingsSearch` parameters of a URL; empty and non-string values are dropped. */
export function parseSettingsSearch(search: Record<string, unknown>): SettingsSearch {
  const item = searchText(search.item)
  const tab = searchText(search.tab)
  const repo = searchText(search.repo)
  return { ...(item && { item }), ...(tab && { tab }), ...(repo && { repo }) }
}

/** `value` as a Settings section, `undefined` for anything else. */
export const parseSettingsSection = (value: unknown): SettingsSectionId | undefined =>
  settingsSectionIds.find((id) => id === value)

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
  'reviews',
  'knowledge',
  'automation',
  'tasks',
] as const

/** Pages outside Settings that edit settings, each through a drawer or a section of its own. */
type SettingsPage = (typeof settingsPages)[number]

/** The settings a page owns: analyzer options in its drawer, policies in its own sections. */
export const pageSettingKeys: Readonly<Record<SettingsPage, readonly string[]>> = {
  bundles: ['analyzers.bundle'],
  dependencies: ['analyzers.depgraph', 'analyzers.renovate'],
  'public-api': ['analyzers.api-surface', 'analyzers.usages'],
  stack: ['analyzers.stack', 'analyzers.browserslist'],
  audits: [
    'analyzers.audit',
    'audit.fix',
    'audit.upgrade',
    'audit.allowlist',
    'audit.allowlistPolicy',
  ],
  licenses: ['analyzers.licenses'],
  coverage: ['analyzers.coverage', 'repo.tests'],
  branches: ['analyzers.branches'],
  ci: ['analyzers.ci-jobs'],
  releases: ['releases'],
  assets: ['analyzers.assets'],
  reviews: ['analyzers.review'],
  knowledge: [...Object.values(sectionPolicies), 'analyzers.guide'],
  automation: [...automationSettingKeys],
  tasks: ['tasks.write'],
}

/** Where a page that owns settings lives: its place in the shell and its route. */
export const settingsPageHomes = {
  bundles: { label: 'Quality › Bundles', to: '/quality/bundles' },
  dependencies: { label: 'Supply › Libraries', to: '/supply/libraries' },
  'public-api': { label: 'Supply › Public API', to: '/supply/public-api' },
  stack: { label: 'Supply › Stack', to: '/supply/stack' },
  audits: { label: 'Supply › Security', to: '/supply/security' },
  licenses: { label: 'Supply › Licenses', to: '/supply/licenses' },
  coverage: { label: 'Quality › Coverage', to: '/quality/coverage' },
  branches: { label: 'Quality › Branches', to: '/quality/branches' },
  ci: { label: 'Quality › CI', to: '/quality/ci' },
  releases: { label: 'Releases', to: '/releases' },
  assets: { label: 'Repository › Assets', to: '/repos' },
  reviews: { label: 'Quality › Reviews', to: '/quality/reviews' },
  knowledge: { label: 'Knowledge › Guide', to: '/knowledge/guide' },
  automation: { label: 'Ops › Automation', to: '/ops/automation' },
  tasks: { label: 'Ops › Tasks', to: '/ops/tasks' },
} as const satisfies Record<SettingsPage, { label: string; to: string }>

/** Where a setting is edited: a Settings section or another page. */
export type SettingHome = { section: SettingsSectionId } | { page: SettingsPage }

const homes = new Map<string, SettingHome>([
  ...settingsPages.flatMap((page) => pageSettingKeys[page].map((key) => [key, { page }] as const)),
  ...settingsSectionIds.flatMap((section) =>
    settingsSections[section].keys.map((key) => [key, { section }] as const),
  ),
])

function sectionHomed(key: string): boolean {
  const home = homes.get(key)
  return home !== undefined && 'section' in home
}

/**
 * Where a setting is edited. Keys no page or section claims (plugin settings, analyzers without a
 * page) are listed under System, so every setting has a home.
 */
export const settingHome = (key: string): SettingHome => homes.get(key) ?? { section: 'system' }

/**
 * The definitions a Settings section shows, in the section's order, then the ones it shares with
 * their pages (`sharedSectionKeys`) in definition order. System also takes every setting no page
 * or section claims, so nothing becomes uneditable.
 */
export function sectionDefinitions(
  definitions: readonly SettingDefinitionView[],
  section: SettingsSectionId,
): SettingDefinitionView[] {
  const own = definitionsOf(definitions, settingsSections[section].keys)
  const shared = sharedSectionKeys[section]
  const extra = shared ? definitions.filter((d) => shared(d.key)) : []
  if (section !== 'system') return [...own, ...extra]
  return [...own, ...definitions.filter((d) => !homes.has(d.key))]
}

/** The definitions of `keys` in that order, skipping keys the server does not define. */
export const definitionsOf = (
  definitions: readonly SettingDefinitionView[],
  keys: readonly string[],
): SettingDefinitionView[] => keys.flatMap((key) => definitions.filter((d) => d.key === key))

/** The element id a setting's entries carry in a Settings section, the target of search links. */
export const settingAnchor = (key: string): string => `setting-${key}`

/**
 * Where Knowledge's Configure leads for a tab: the Guide generator's options (Settings › Analyzers,
 * `guide`), the auto-accept policy for agent notes (Settings › Policies) or the review analyzer
 * whose replies become learnings (Settings › Analyzers, `review`).
 */
export function knowledgeSettingsLink(tab: KnowledgeTab) {
  if (tab === 'notes')
    return {
      to: '/settings/$section',
      params: { section: 'policies' },
      hash: settingAnchor('knowledge.autoAccept'),
    } as const
  return {
    to: '/settings/$section',
    params: { section: 'analyzers' },
    search: { item: tab === 'guide' ? 'guide' : 'review' },
  } as const
}
