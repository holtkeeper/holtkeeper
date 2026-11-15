import { hasWildcard, patternMatches, splitPattern } from '@holtkeeper/access/paths'
import { type HoltkeeperConfig, fleetPatterns, resolveRepo } from '@holtkeeper/core'
import { type RepoRef, forgeErrorStatus } from '@holtkeeper/forge'

/** Which fleet repositories a schedule, trigger or analyzer run targets. Both absent = the whole fleet. */
export interface RepoSelection {
  /** Repositories owned by one of these teams. */
  teams?: readonly string[]
  /** Repositories matching one of these path patterns (forge prefix optional). */
  repos?: readonly string[]
}

/** Lists the fleet repositories a selection covers, sorted by forge and path. */
export type ResolveRepos = (selection?: RepoSelection) => Promise<RepoRef[]>

/** The namespace to list for an include glob: everything before its first wildcard segment. */
export function staticPrefix(pattern: string): string {
  const segments = pattern.split('/')
  const index = segments.findIndex((segment) => hasWildcard(segment))
  return (index === -1 ? segments : segments.slice(0, index)).join('/')
}

const globMatches = (globs: readonly string[], path: string) =>
  globs.some((glob) => new Bun.Glob(glob).match(path))

/**
 * Whether the selection covers the repository: one of its owner teams (`resolveRepo`) is in
 * `teams`, or a `repos` pattern matches it (forge prefix optional). Everything when both are
 * absent or empty.
 */
export function selectionCovers(
  config: Pick<HoltkeeperConfig, 'teams' | 'repos'>,
  selection: RepoSelection | undefined,
  repo: RepoRef,
): boolean {
  const teams = selection?.teams ?? []
  const repos = selection?.repos ?? []
  if (!teams.length && !repos.length) return true
  if (repos.some((pattern) => patternMatches(pattern, repo.forge, repo.path))) return true
  return teams.length > 0 && resolveRepo(config, repo).teams.some((team) => teams.includes(team))
}

/** The globs (without forge prefix) worth listing on `forge` for a selection. */
function listedGlobs(
  config: HoltkeeperConfig,
  forge: string,
  selection: RepoSelection | undefined,
  fleet: readonly string[],
): string[] {
  const teams = selection?.teams ?? []
  const repos = selection?.repos ?? []
  if (!teams.length && !repos.length) return [...fleet]
  const patterns = [...repos, ...teams.flatMap((team) => config.teams[team]?.owns ?? [])]
  const globs = new Set<string>()
  for (const pattern of patterns) {
    const split = splitPattern(pattern)
    if (split.forge === undefined || split.forge === forge) globs.add(split.glob)
  }
  return [...globs]
}

/**
 * Lists the fleet of every configured forge (`fleetPatterns`: the forge's includes plus what teams
 * own or consume, minus the forge's excludes), then keeps the repositories `selectionCovers`. Each
 * glob's static prefix is listed with `GitForge.listRepositories`; a pattern without wildcards is
 * one repository, read with `GitForge.getRepository` (one the forge does not know is skipped).
 * Only the patterns a selection can reach are listed. Archived repositories are skipped.
 */
export function fleetRepositories(config: HoltkeeperConfig): ResolveRepos {
  return async (selection) => {
    const found = new Map<string, RepoRef>()
    for (const [forgeId, definition] of Object.entries(config.forges)) {
      const fleet = fleetPatterns(config, forgeId)
      if (!fleet.include.length) continue
      const globs = listedGlobs(config, forgeId, selection, fleet.include)
      if (!globs.length) continue
      const forge = definition.create()
      const keep = (path: string) =>
        globMatches(fleet.include, path) &&
        !globMatches(fleet.exclude, path) &&
        selectionCovers(config, selection, { forge: forgeId, path })
      const add = (path: string) => found.set(`${forgeId}:${path}`, { forge: forgeId, path })

      for (const path of globs.filter((glob) => !hasWildcard(glob))) {
        if (!keep(path)) continue
        try {
          // oxlint-disable-next-line no-await-in-loop -- one repository after another keeps rate limits
          const repository = await forge.getRepository(path)
          if (!repository.archived) add(path)
        } catch (error) {
          // A bare pattern applies to every forge; a forge without that repository just lacks it.
          if (forgeErrorStatus(error) !== 404) throw error
        }
      }
      const namespaces = new Set(globs.filter((glob) => hasWildcard(glob)).map(staticPrefix))
      for (const namespace of namespaces) {
        // oxlint-disable-next-line no-await-in-loop -- one listing after another keeps rate limits
        for await (const repository of forge.listRepositories(namespace)) {
          if (!repository.archived && keep(repository.path)) add(repository.path)
        }
      }
    }
    return [...found.values()].toSorted(
      (a, b) => a.forge.localeCompare(b.forge) || a.path.localeCompare(b.path),
    )
  }
}

/**
 * The forges a team's repositories can live on, for team-scope analyzer jobs (`{ forge, path:
 * <team> }`): the forge of every forge-qualified `owns` pattern, and every configured forge when
 * one pattern has no forge prefix. Config order; empty for an unknown team.
 */
export function teamForges(
  config: Pick<HoltkeeperConfig, 'forges' | 'teams'>,
  team: string,
): string[] {
  const owns = config.teams[team]?.owns ?? []
  const named = new Set(owns.map((pattern) => splitPattern(pattern).forge))
  return Object.keys(config.forges).filter((forge) => named.has(undefined) || named.has(forge))
}

/** Whether `repo` matches a path pattern such as `work:acme/*` or `acme/*` (any forge). */
export const matchesRepoGlob = (pattern: string, repo: RepoRef): boolean =>
  patternMatches(pattern, repo.forge, repo.path)
