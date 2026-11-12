import type { GroupMatch } from '@holtkeeper/api'

import { type GroupTitleOf, keyAsTitle } from './group-titles.ts'

/**
 * A position of the scope switch every list page shares: *My teams*, *All I can see*, or one
 * group (`group:<name>`). The string is also its stored form.
 */
export type ScopeView = 'mine' | 'all' | `group:${string}`

const groupPrefix = 'group:'

/** The scope position of one group. */
export const groupView = (group: string): ScopeView => `group:${group}`

/** The group a position narrows to; `undefined` for *My teams* and *All I can see*. */
export const viewGroup = (view: ScopeView): string | undefined =>
  view.startsWith(groupPrefix) ? view.slice(groupPrefix.length) : undefined

/** Words naming a narrowed scope after a count: " of my teams", " in widgets", or nothing for *All I can see*. */
export const scopeSuffix = (view: ScopeView, titleOf: GroupTitleOf = keyAsTitle): string =>
  view === 'all' ? '' : view === 'mine' ? ' of my teams' : ` in ${titleOf(viewGroup(view) ?? '')}`

/** A position's name in running text: "My teams", "All I can see" or the group's title. */
export const scopeLabel = (view: ScopeView, titleOf: GroupTitleOf = keyAsTitle): string =>
  view === 'all' ? 'All I can see' : view === 'mine' ? 'My teams' : titleOf(viewGroup(view) ?? '')

/** A stored scope position; anything else, including retired positions, is `undefined`. */
export function parseScopeView(value: unknown): ScopeView | undefined {
  if (value === 'mine' || value === 'all') return value
  if (typeof value !== 'string' || !value.startsWith(groupPrefix)) return undefined
  const group = value.slice(groupPrefix.length).trim()
  return group ? groupView(group) : undefined
}

/** The position until the viewer picks one, or when the picked group is gone: *My teams*. */
export const defaultScopeView: ScopeView = 'mine'

/**
 * The position to show: `chosen` unless it names a group outside `groups` (the groups the viewer
 * can see), then the default. With `groups` unknown yet, `chosen` stands.
 */
export function resolveScopeView(
  chosen: ScopeView | undefined,
  groups: readonly string[] | undefined,
): ScopeView {
  if (!chosen) return defaultScopeView
  const group = viewGroup(chosen)
  return group === undefined || !groups || groups.includes(group) ? chosen : defaultScopeView
}

const allOf = (entry: GroupMatch) => (typeof entry === 'string' ? [entry] : entry)

/** Whether something in `groups` belongs to one of the home groups (`frontend + storefront` needs both). */
export const inHomeGroups = (
  homeGroups: readonly GroupMatch[],
  groups: readonly string[],
): boolean => homeGroups.some((entry) => allOf(entry).every((group) => groups.includes(group)))

/** Whether something in `groups` belongs to a scope position. */
export function inView(
  view: ScopeView,
  homeGroups: readonly GroupMatch[],
  groups: readonly string[],
): boolean {
  if (view === 'all') return true
  if (view === 'mine') return inHomeGroups(homeGroups, groups)
  return groups.includes(viewGroup(view) ?? '')
}

/**
 * The `groups` filter a scope position sends to the server: every group named in the home groups
 * for *My teams*, the one group of a group position, `undefined` (no filter) for *All I can see*.
 */
export function viewGroups(
  view: ScopeView,
  homeGroups: readonly GroupMatch[],
): string[] | undefined {
  if (view === 'all') return undefined
  const group = viewGroup(view)
  return group === undefined ? [...new Set(homeGroups.flatMap(allOf))] : [group]
}

/** How many items one group holds. */
export interface GroupCount {
  group: string
  count: number
}

/** Item counts of the scope switch: per position and per group, groups sorted by name. */
export interface ScopeCounts {
  mine: number
  all: number
  groups: readonly GroupCount[]
}

/** Items per group, given each item's groups; sorted by group name. */
export function groupCounts(groupLists: Iterable<readonly string[]>): GroupCount[] {
  const counts = new Map<string, number>()
  for (const groups of groupLists)
    for (const group of new Set(groups)) counts.set(group, (counts.get(group) ?? 0) + 1)
  return [...counts]
    .map(([group, count]) => ({ group, count }))
    .toSorted((a, b) => a.group.localeCompare(b.group))
}

/** What a list shows for a scope position, plus the counts the switch and the folded line need. */
export interface ScopedList<T> {
  shown: T[]
  counts: ScopeCounts
  /** Items outside the home groups and the groups they are in, e.g. "4 repos of 2 other teams". */
  others: { items: number; teams: number }
}

/**
 * Splits `items` by the viewer's home groups. A UI default, not a permission: `items` are what the
 * viewer may already see.
 */
export function scopeList<T extends { groups: readonly string[] }>(
  items: readonly T[],
  view: ScopeView,
  homeGroups: readonly GroupMatch[],
): ScopedList<T> {
  const mine: T[] = []
  const rest: T[] = []
  for (const item of items) (inHomeGroups(homeGroups, item.groups) ? mine : rest).push(item)
  const homeNames = new Set(homeGroups.filter((entry) => typeof entry === 'string'))
  const teams = new Set(rest.flatMap((item) => item.groups).filter((g) => !homeNames.has(g)))
  return {
    shown: view === 'mine' ? mine : items.filter((item) => inView(view, homeGroups, item.groups)),
    counts: {
      mine: mine.length,
      all: items.length,
      groups: groupCounts(items.map((item) => item.groups)),
    },
    others: { items: rest.length, teams: teams.size },
  }
}

/** Items split into the viewer's team and other teams, for a collapsed "Other teams (N)" section. */
export interface FoldedTeams<T> {
  mine: T[]
  others: T[]
  /** Groups the other teams' items are in, home groups left out, sorted. */
  teams: string[]
}

/**
 * Splits `items` by owner: those `groupsOf` puts in a home group, or that belong to nobody, stay
 * in `mine`; the rest fold into `others`. Without home groups nothing folds. A UI default, not a
 * permission: `items` are what the viewer may already see.
 */
export function foldOtherTeams<T>(
  items: readonly T[],
  homeGroups: readonly GroupMatch[],
  groupsOf: (item: T) => readonly string[],
): FoldedTeams<T> {
  if (!homeGroups.length) return { mine: [...items], others: [], teams: [] }
  const mine: T[] = []
  const others: T[] = []
  for (const item of items) {
    const groups = groupsOf(item)
    ;(!groups.length || inHomeGroups(homeGroups, groups) ? mine : others).push(item)
  }
  const homeNames = new Set(homeGroups.flatMap(allOf))
  const teams = [...new Set(others.flatMap(groupsOf))].filter((g) => !homeNames.has(g)).toSorted()
  return { mine, others, teams }
}

/** A list under a scope position: what shows, what folds into *Other teams*, and the counts. */
export interface FoldedScope<T> {
  shown: T[]
  /** Other teams' items, folded under *My teams* only. */
  others: T[]
  /** Groups the folded items are in, home groups left out, sorted. */
  teams: string[]
  counts: ScopeCounts
}

/**
 * `items` under a scope position. *My teams* keeps items in a home group or in no group and folds
 * the rest; without home groups it keeps only items in no group and folds nothing. A group position keeps that group's
 * items, *All I can see* everything; neither folds. A UI default, not a permission.
 */
export function foldScope<T>(
  items: readonly T[],
  view: ScopeView,
  homeGroups: readonly GroupMatch[],
  groupsOf: (item: T) => readonly string[],
): FoldedScope<T> {
  const folded = homeGroups.length
    ? foldOtherTeams(items, homeGroups, groupsOf)
    : { mine: items.filter((item) => !groupsOf(item).length), others: [], teams: [] }
  const group = viewGroup(view)
  const mine = view === 'mine'
  return {
    shown: mine
      ? folded.mine
      : group === undefined
        ? [...items]
        : items.filter((item) => groupsOf(item).includes(group)),
    others: mine ? folded.others : [],
    teams: mine ? folded.teams : [],
    counts: {
      mine: folded.mine.length,
      all: items.length,
      groups: groupCounts(items.map(groupsOf)),
    },
  }
}
