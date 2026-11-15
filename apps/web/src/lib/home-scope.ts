import { type TeamTitleOf, byTeamTitle, keyAsTitle } from './team-titles.ts'

/**
 * A position of the scope switch every list page shares: *My teams*, *All I can see*, or one
 * team (`team:<key>`). The string is also its stored form.
 */
export type ScopeView = 'mine' | 'all' | `team:${string}`

const teamPrefix = 'team:'

/** The scope position of one team. */
export const teamView = (team: string): ScopeView => `team:${team}`

/** The team a position narrows to; `undefined` for *My teams* and *All I can see*. */
export const viewTeam = (view: ScopeView): string | undefined =>
  view.startsWith(teamPrefix) ? view.slice(teamPrefix.length) : undefined

/**
 * Words naming a narrowed scope after a count: " of my teams", " in Widget works", or nothing for
 * *All I can see*.
 */
export const scopeSuffix = (view: ScopeView, titleOf: TeamTitleOf = keyAsTitle): string =>
  view === 'all' ? '' : view === 'mine' ? ' of my teams' : ` in ${titleOf(viewTeam(view) ?? '')}`

/** A position's name in running text: "My teams", "All I can see" or the team's title. */
export const scopeLabel = (view: ScopeView, titleOf: TeamTitleOf = keyAsTitle): string =>
  view === 'all' ? 'All I can see' : view === 'mine' ? 'My teams' : titleOf(viewTeam(view) ?? '')

/** A stored scope position; anything else, including retired positions, is `undefined`. */
export function parseScopeView(value: unknown): ScopeView | undefined {
  if (value === 'mine' || value === 'all') return value
  if (typeof value !== 'string' || !value.startsWith(teamPrefix)) return undefined
  const team = value.slice(teamPrefix.length).trim()
  return team ? teamView(team) : undefined
}

/** The position until the viewer picks one, or when the picked team is gone: *My teams*. */
export const defaultScopeView: ScopeView = 'mine'

/**
 * The position to show: `chosen` unless it names a team outside `teams` (the teams the viewer
 * can see), then the default. With `teams` unknown yet, `chosen` stands.
 */
export function resolveScopeView(
  chosen: ScopeView | undefined,
  teams: readonly string[] | undefined,
): ScopeView {
  if (!chosen) return defaultScopeView
  const team = viewTeam(chosen)
  return team === undefined || !teams || teams.includes(team) ? chosen : defaultScopeView
}

/** Whether something owned by `teams` belongs to one of the home teams. */
export const inHomeTeams = (homeTeams: readonly string[], teams: readonly string[]): boolean =>
  homeTeams.some((team) => teams.includes(team))

/** Whether something owned by `teams` belongs to a scope position. */
export function inView(
  view: ScopeView,
  homeTeams: readonly string[],
  teams: readonly string[],
): boolean {
  if (view === 'all') return true
  if (view === 'mine') return inHomeTeams(homeTeams, teams)
  return teams.includes(viewTeam(view) ?? '')
}

/**
 * The `teams` filter a scope position sends to the server: the home teams for *My teams*, the
 * one team of a team position, `undefined` (no filter) for *All I can see*.
 */
export function viewTeams(view: ScopeView, homeTeams: readonly string[]): string[] | undefined {
  if (view === 'all') return undefined
  const team = viewTeam(view)
  return team === undefined ? [...new Set(homeTeams)] : [team]
}

/** How many items one team owns. */
export interface TeamCount {
  team: string
  count: number
}

/** Item counts of the scope switch: per position and per team. */
export interface ScopeCounts {
  mine: number
  all: number
  teams: readonly TeamCount[]
}

/** Items per team, given each item's owner teams; sorted by key. */
export function teamCounts(teamLists: Iterable<readonly string[]>): TeamCount[] {
  const counts = new Map<string, number>()
  for (const teams of teamLists)
    for (const team of new Set(teams)) counts.set(team, (counts.get(team) ?? 0) + 1)
  return [...counts]
    .map(([team, count]) => ({ team, count }))
    .toSorted((a, b) => byTeamTitle(keyAsTitle)(a.team, b.team))
}

/** What a list shows for a scope position, plus the counts the switch and the folded line need. */
export interface ScopedList<T> {
  shown: T[]
  counts: ScopeCounts
  /** Items outside the home teams and the teams owning them, e.g. "4 repos of 2 other teams". */
  others: { items: number; teams: number }
}

/**
 * Splits `items` by the viewer's home teams. A UI default, not a permission: `items` are what the
 * viewer may already see.
 */
export function scopeList<T extends { teams: readonly string[] }>(
  items: readonly T[],
  view: ScopeView,
  homeTeams: readonly string[],
): ScopedList<T> {
  const mine: T[] = []
  const rest: T[] = []
  for (const item of items) (inHomeTeams(homeTeams, item.teams) ? mine : rest).push(item)
  const home = new Set(homeTeams)
  const teams = new Set(rest.flatMap((item) => item.teams).filter((team) => !home.has(team)))
  return {
    shown: view === 'mine' ? mine : items.filter((item) => inView(view, homeTeams, item.teams)),
    counts: {
      mine: mine.length,
      all: items.length,
      teams: teamCounts(items.map((item) => item.teams)),
    },
    others: { items: rest.length, teams: teams.size },
  }
}

/** Items split into the viewer's teams and other teams, for a collapsed "Other teams (N)" section. */
export interface FoldedTeams<T> {
  mine: T[]
  others: T[]
  /** The teams owning the folded items, home teams left out, sorted. */
  teams: string[]
}

/**
 * Splits `items` by owner: those `teamsOf` gives a home team, or that belong to nobody, stay in
 * `mine`; the rest fold into `others`. Without home teams nothing folds. A UI default, not a
 * permission: `items` are what the viewer may already see.
 */
export function foldOtherTeams<T>(
  items: readonly T[],
  homeTeams: readonly string[],
  teamsOf: (item: T) => readonly string[],
): FoldedTeams<T> {
  if (!homeTeams.length) return { mine: [...items], others: [], teams: [] }
  const mine: T[] = []
  const others: T[] = []
  for (const item of items) {
    const teams = teamsOf(item)
    ;(!teams.length || inHomeTeams(homeTeams, teams) ? mine : others).push(item)
  }
  const home = new Set(homeTeams)
  const teams = [...new Set(others.flatMap(teamsOf))].filter((t) => !home.has(t)).toSorted()
  return { mine, others, teams }
}

/** A list under a scope position: what shows, what folds into *Other teams*, and the counts. */
export interface FoldedScope<T> {
  shown: T[]
  /** Other teams' items, folded under *My teams* only. */
  others: T[]
  /** Teams owning the folded items, home teams left out, sorted. */
  teams: string[]
  counts: ScopeCounts
}

/**
 * `items` under a scope position. *My teams* keeps items of a home team or of no team and folds
 * the rest; without home teams it keeps only items of no team and folds nothing. A team position
 * keeps that team's items, *All I can see* everything; neither folds. A UI default, not a
 * permission.
 */
export function foldScope<T>(
  items: readonly T[],
  view: ScopeView,
  homeTeams: readonly string[],
  teamsOf: (item: T) => readonly string[],
): FoldedScope<T> {
  const folded = homeTeams.length
    ? foldOtherTeams(items, homeTeams, teamsOf)
    : { mine: items.filter((item) => !teamsOf(item).length), others: [], teams: [] }
  const team = viewTeam(view)
  const mine = view === 'mine'
  return {
    shown: mine
      ? folded.mine
      : team === undefined
        ? [...items]
        : items.filter((item) => teamsOf(item).includes(team)),
    others: mine ? folded.others : [],
    teams: mine ? folded.teams : [],
    counts: {
      mine: folded.mine.length,
      all: items.length,
      teams: teamCounts(items.map(teamsOf)),
    },
  }
}
