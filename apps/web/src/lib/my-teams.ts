import type { GroupMatch, RepoHealthStatus, RepoRef } from '@holtkeeper/api'

/** One group the viewer can add to My teams. */
export interface TeamRow {
  group: string
  /** Repositories in the group the viewer can see. */
  repos: number
  /** Forges those repositories live on, sorted. */
  forges: string[]
  /** Whether My teams names the group on its own (not only inside a combination). */
  inMyTeams: boolean
  /** Its repositories per overall health; every status is present, zero when none has it. */
  health: Record<RepoHealthStatus, number>
}

/** Every group of the visible repositories with its size, forges and health, by name. */
export function teamRows(
  repos: readonly { repo: RepoRef; groups: readonly string[]; health?: RepoHealthStatus }[],
  homeGroups: readonly GroupMatch[],
): TeamRow[] {
  const byGroup = new Map<
    string,
    { repos: number; forges: Set<string>; health: Record<RepoHealthStatus, number> }
  >()
  for (const { repo, groups, health } of repos)
    for (const group of groups) {
      const row = byGroup.get(group) ?? {
        repos: 0,
        forges: new Set<string>(),
        health: { failing: 0, warnings: 0, 'not-analysed': 0, healthy: 0 },
      }
      row.repos += 1
      row.forges.add(repo.forge)
      if (health) row.health[health] += 1
      byGroup.set(group, row)
    }
  return [...byGroup]
    .map(([group, row]) => ({
      group,
      repos: row.repos,
      forges: [...row.forges].toSorted(),
      inMyTeams: homeGroups.includes(group),
      health: row.health,
    }))
    .toSorted((a, b) => a.group.localeCompare(b.group))
}

/** Home groups with `group` added on its own or removed; combinations stay as they are. */
export const toggleHomeGroup = (
  homeGroups: readonly GroupMatch[],
  group: string,
  on: boolean,
): GroupMatch[] =>
  on
    ? homeGroups.includes(group)
      ? [...homeGroups]
      : [...homeGroups, group]
    : homeGroups.filter((entry) => entry !== group)

/** The combinations (`frontend + storefront`) among the home groups. */
export const homeCombinations = (homeGroups: readonly GroupMatch[]): string[][] =>
  homeGroups.filter((entry): entry is string[] => typeof entry !== 'string')
