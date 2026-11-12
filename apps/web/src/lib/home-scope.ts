import type { GroupMatch } from '@holtkeeper/api'

/** The two positions of the scope switch every list page shares. */
export type ScopeView = 'mine' | 'all'

const scopeViews: readonly ScopeView[] = ['mine', 'all']

/** A stored scope position; anything else, including retired positions, is `undefined`. */
export const parseScopeView = (value: unknown): ScopeView | undefined =>
  scopeViews.find((view) => view === value)

/** *My teams* when the viewer has home groups, otherwise *All I can see*. */
export const defaultScopeView = (homeGroups: readonly GroupMatch[]): ScopeView =>
  homeGroups.length ? 'mine' : 'all'

const allOf = (entry: GroupMatch) => (typeof entry === 'string' ? [entry] : entry)

/** Whether something in `groups` belongs to one of the home groups (`frontend + storefront` needs both). */
export const inHomeGroups = (
  homeGroups: readonly GroupMatch[],
  groups: readonly string[],
): boolean => homeGroups.some((entry) => allOf(entry).every((group) => groups.includes(group)))

/** What a list shows for a scope position, plus the counts the switch and the folded line need. */
export interface ScopedList<T> {
  shown: T[]
  counts: Record<ScopeView, number>
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
    shown: view === 'mine' ? mine : [...items],
    counts: { mine: mine.length, all: items.length },
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
