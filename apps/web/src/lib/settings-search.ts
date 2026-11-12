import type { SettingDefinitionView } from '@holtkeeper/api'

import {
  type SettingsSectionId,
  settingAnchor,
  settingHome,
  settingsPageHomes,
  settingsSections,
} from './settings-sections.ts'

/** Where a search result leads: a Settings section (at a setting's entries) or the page that owns it. */
type SettingsLink =
  | { to: '/settings/$section'; params: { section: SettingsSectionId }; hash?: string }
  | { to: (typeof settingsPageHomes)[keyof typeof settingsPageHomes]['to'] }

/** One searchable thing: a Settings section, or a setting wherever it is edited. */
export interface SettingsSearchEntry {
  /** `section:<id>` or `setting:<key>`. */
  id: string
  kind: 'section' | 'setting'
  /** The setting key, for settings. */
  key?: string
  label: string
  description: string
  /** The setting's `SettingDefinition.section`; `Settings` for sections. */
  group: string
  /** Where it is edited, e.g. `Settings › AI` or `Quality › Coverage`. */
  where: string
  link: SettingsLink
  text: string
}

const sectionsGroup = 'Settings'

const settingsWhere = (section: SettingsSectionId) =>
  `Settings › ${settingsSections[section].label}`

const haystack = (...parts: string[]) => parts.join(' ').toLowerCase()

/**
 * Every Settings section in `sections` and every setting of `definitions`, each with where it is
 * edited. A setting edited on another page links to that page and says so in `where`; a setting
 * whose section is not in `sections` is left out, since its link would not open.
 */
export function settingsIndex(
  definitions: readonly SettingDefinitionView[],
  sections: readonly SettingsSectionId[],
): SettingsSearchEntry[] {
  const sectionEntries = sections.map((section): SettingsSearchEntry => {
    const { label, description } = settingsSections[section]
    return {
      id: `section:${section}`,
      kind: 'section',
      label,
      description,
      group: sectionsGroup,
      where: settingsWhere(section),
      link: { to: '/settings/$section', params: { section } },
      text: haystack(label, description, section),
    }
  })
  const settingEntries = definitions.flatMap((definition): SettingsSearchEntry[] => {
    const home = settingHome(definition.key)
    if ('section' in home && !sections.includes(home.section)) return []
    const where =
      'section' in home ? settingsWhere(home.section) : settingsPageHomes[home.page].label
    const link: SettingsLink =
      'section' in home
        ? {
            to: '/settings/$section',
            params: { section: home.section },
            hash: settingAnchor(definition.key),
          }
        : { to: settingsPageHomes[home.page].to }
    return [
      {
        id: `setting:${definition.key}`,
        kind: 'setting',
        key: definition.key,
        label: definition.label,
        description: definition.description,
        group: definition.section,
        where,
        link,
        text: haystack(
          definition.label,
          definition.key,
          definition.description,
          definition.section,
          where,
        ),
      },
    ]
  })
  return [...sectionEntries, ...settingEntries]
}

const rank = (entry: SettingsSearchEntry, query: string) => {
  const label = entry.label.toLowerCase()
  if (label.startsWith(query) || entry.key?.toLowerCase().startsWith(query)) return 0
  if (label.includes(query) || entry.key?.toLowerCase().includes(query)) return 1
  return 2
}

/**
 * The entries matching every word of `query` (case-insensitive, in label, key, description,
 * group or where), best first: label or key prefix, then label or key match, then the rest;
 * sections before settings on a tie. An empty query matches nothing.
 */
export function searchSettings(
  index: readonly SettingsSearchEntry[],
  query: string,
): SettingsSearchEntry[] {
  const normalized = query.trim().toLowerCase()
  const words = normalized.split(/\s+/).filter(Boolean)
  if (!words.length) return []
  return index
    .filter((entry) => words.every((word) => entry.text.includes(word)))
    .map((entry, order) => ({ entry, order, score: rank(entry, normalized) }))
    .toSorted(
      (a, b) =>
        a.score - b.score ||
        Number(a.entry.kind === 'setting') - Number(b.entry.kind === 'setting') ||
        a.order - b.order,
    )
    .map(({ entry }) => entry)
}

/** `entries` grouped by `group`, groups in the order their first entry appears. */
export function groupSettingsResults(
  entries: readonly SettingsSearchEntry[],
): { group: string; entries: SettingsSearchEntry[] }[] {
  const groups = new Map<string, SettingsSearchEntry[]>()
  for (const entry of entries) groups.set(entry.group, [...(groups.get(entry.group) ?? []), entry])
  return [...groups].map(([group, list]) => ({ group, entries: list }))
}
