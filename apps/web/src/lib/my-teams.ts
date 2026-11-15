import type { RepoHealthStatus, RepoRef } from '@holtkeeper/api'

import { type TeamTitleOf, byTeamTitle, keyAsTitle } from './team-titles.ts'

/** One team the viewer can add to My teams. */
export interface MyTeamRow {
  team: string
  /** Repositories the team owns that the viewer can see. */
  repos: number
  /** Forges those repositories live on, sorted. */
  forges: string[]
  /** Whether My teams names the team. */
  inMyTeams: boolean
  /** Its repositories per overall health; every status is present, zero when none has it. */
  health: Record<RepoHealthStatus, number>
}

const noHealth = (): Record<RepoHealthStatus, number> => ({
  failing: 0,
  warnings: 0,
  'not-analysed': 0,
  healthy: 0,
})

/**
 * Every team owning a visible repository, plus the `known` teams (e.g. every titled team) and the
 * home teams even when they own nothing visible, with size, forges and health, sorted by title.
 */
export function myTeamRows(
  repos: readonly { repo: RepoRef; teams: readonly string[]; health?: RepoHealthStatus }[],
  homeTeams: readonly string[],
  titleOf: TeamTitleOf = keyAsTitle,
  known: readonly string[] = [],
): MyTeamRow[] {
  const byTeam = new Map<
    string,
    { repos: number; forges: Set<string>; health: Record<RepoHealthStatus, number> }
  >()
  const rowOf = (team: string) => {
    const row = byTeam.get(team) ?? { repos: 0, forges: new Set<string>(), health: noHealth() }
    byTeam.set(team, row)
    return row
  }
  for (const { repo, teams, health } of repos)
    for (const team of teams) {
      const row = rowOf(team)
      row.repos += 1
      row.forges.add(repo.forge)
      if (health) row.health[health] += 1
    }
  for (const team of [...known, ...homeTeams]) rowOf(team)
  const order = byTeamTitle(titleOf)
  return [...byTeam]
    .map(([team, row]) => ({
      team,
      repos: row.repos,
      forges: [...row.forges].toSorted(),
      inMyTeams: homeTeams.includes(team),
      health: row.health,
    }))
    .toSorted((a, b) => order(a.team, b.team))
}

/** Home teams with `team` added or removed. */
export const toggleHomeTeam = (homeTeams: readonly string[], team: string, on: boolean): string[] =>
  on
    ? homeTeams.includes(team)
      ? [...homeTeams]
      : [...homeTeams, team]
    : homeTeams.filter((entry) => entry !== team)
