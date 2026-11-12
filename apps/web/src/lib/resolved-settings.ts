import type {
  ResolvedSettingRow,
  SettingDefinitionView,
  SettingLayer,
  SettingSource,
  SettingView,
} from '@holtkeeper/api'

import { keyAsTitle, type GroupTitleOf } from './group-titles.ts'
import { type ScopeFocus, focusParent, namesFocus } from './scope.ts'

/** Which rows the resolver shows: every key, those set on the focus itself, those not at their default. */
export type ResolvedFilter = 'all' | 'here' | 'changed'

/** A category of the resolver: one definition section and its rows. */
export interface ResolvedSection<R extends ResolvedSettingRow = ResolvedSettingRow> {
  id: string
  label: string
  rows: R[]
}

/** The `section` search value of a category label, e.g. `Merge requests` → `merge-requests`. */
export const sectionSlug = (label: string): string =>
  label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/** Rows grouped by their definition section, sections in the order their first key appears. */
export function resolvedSections<R extends ResolvedSettingRow>(
  rows: readonly R[],
): ResolvedSection<R>[] {
  const sections = new Map<string, ResolvedSection<R>>()
  for (const row of rows) {
    const id = sectionSlug(row.section)
    const section = sections.get(id) ?? { id, label: row.section, rows: [] }
    section.rows.push(row)
    sections.set(id, section)
  }
  return [...sections.values()]
}

/** Whether the winning entry names the focus itself rather than covering it from a broader scope. */
export const setHere = (row: ResolvedSettingRow, focus: ScopeFocus): boolean =>
  row.entry !== undefined && namesFocus(row.entry.scope, focus)

/** Whether `row` passes `filter` and its label or key contains `query` (case-insensitive). */
export function rowMatches(
  row: ResolvedSettingRow,
  focus: ScopeFocus,
  filter: ResolvedFilter,
  query = '',
): boolean {
  if (filter === 'here' && !setHere(row, focus)) return false
  if (filter === 'changed' && row.source.layer === 'default') return false
  const text = query.trim().toLowerCase()
  return !text || row.label.toLowerCase().includes(text) || row.key.toLowerCase().includes(text)
}

/** How many rows each layer wins, for the layer legend. */
export function layerCounts(rows: readonly ResolvedSettingRow[]): Record<SettingLayer, number> {
  const counts: Record<SettingLayer, number> = { default: 0, org: 0, group: 0, repo: 0 }
  for (const row of rows) counts[row.source.layer] += 1
  return counts
}

/**
 * Whether a subgroup focus inherits the source from its parent group: a group entry that matched
 * on the parent and not on the subgroup itself.
 */
export function fromParentGroup(source: SettingSource, focus: ScopeFocus): boolean {
  const parent = focusParent(focus)
  return (
    source.layer === 'group' &&
    parent !== undefined &&
    focus.kind === 'group' &&
    (source.groups ?? []).includes(parent) &&
    !(source.groups ?? []).includes(focus.group)
  )
}

/** How many rows a subgroup focus inherits from its parent group; 0 for any other focus. */
export const parentGroupCount = (rows: readonly ResolvedSettingRow[], focus: ScopeFocus): number =>
  rows.filter((row) => fromParentGroup(row.source, focus)).length

/**
 * Who a source is, in words: `Default`, `Org`, `Group web`, `This repo`, `This group`, and
 * `Parent group` on a subgroup focus for an entry of its parent.
 */
export function sourceLabel(
  source: SettingSource,
  focus: ScopeFocus,
  titleOf: GroupTitleOf = keyAsTitle,
): string {
  if (source.layer === 'default') return 'Default'
  if (source.layer === 'org') return 'Org'
  if (source.layer === 'repo')
    return focus.kind === 'repo' && source.entry && namesFocus(source.entry.scope, focus)
      ? 'This repo'
      : 'Repo pattern'
  if (focus.kind === 'group' && source.groups?.includes(focus.group)) return 'This group'
  if (fromParentGroup(source, focus)) return 'Parent group'
  return `Group ${(source.groups ?? []).map(titleOf).join(' + ')}`.trim()
}

/** A key as it applies to the whole organization, with how many narrower entries replace it somewhere. */
export interface OrgSettingRow extends ResolvedSettingRow {
  /** Entries scoped to groups or repositories, which win over this value where they apply. */
  narrower: number
}

/**
 * Every non-secret key at the organization layer, in definition order: the newest entry scoped
 * `{ all: true }` wins (`org`), otherwise the definition's default applies. This is the resolver's
 * answer for a repository no group or path entry reaches.
 */
export function orgRows(
  definitions: readonly SettingDefinitionView[],
  settings: readonly SettingView[],
): OrgSettingRow[] {
  return definitions
    .filter((definition) => !definition.secret)
    .map((definition): OrgSettingRow => {
      const entries = settings.filter((entry) => entry.key === definition.key)
      const winner = entries
        .filter((entry) => entry.scope.all)
        .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
      const { key, label, section } = definition
      const narrower = entries.filter((entry) => !entry.scope.all).length
      if (!winner)
        return {
          key,
          label,
          section,
          value: definition.default,
          source: { layer: 'default' },
          overrides: 0,
          narrower,
        }
      return {
        key,
        label,
        section,
        value: winner.value,
        source: { layer: 'org', entry: winner },
        replaces: { layer: 'default', value: definition.default },
        entry: winner,
        overrides: 0,
        narrower,
      }
    })
}

/** Whether an org row matches `query` by label or key and, with `changedOnly`, is not at its default. */
export const orgRowMatches = (row: OrgSettingRow, query: string, changedOnly = false): boolean =>
  (!changedOnly || row.source.layer !== 'default' || row.narrower > 0) &&
  rowMatches(row, { kind: 'group', group: '' }, 'all', query)
