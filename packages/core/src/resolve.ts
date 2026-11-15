import { patternMatches, teamsOwning } from '@holtkeeper/access'
import type { RepoRef } from '@holtkeeper/forge'

import type { HoltkeeperConfig } from './config.ts'

/** Facts about a repository from the config's `repos`, such as `{ ssr: false }`. */
export type Traits = Record<string, string | number | boolean>

export interface ResolvedRepo {
  repo: RepoRef
  /** Every team owning the repository, in config order; empty when nobody does. */
  teams: string[]
  /** Teams that consume the repository without owning it, in config order. */
  consumers: string[]
  traits: Traits
}

/** What applies to a repository: the teams owning and consuming it and its merged traits. */
export function resolveRepo(
  config: Pick<HoltkeeperConfig, 'teams' | 'repos'>,
  repo: RepoRef,
): ResolvedRepo {
  const teams = teamsOwning(config.teams, repo.forge, repo.path)
  const consumers = Object.entries(config.teams)
    .filter(
      ([key, team]) =>
        !teams.includes(key) &&
        team.consumes.some((pattern) => patternMatches(pattern, repo.forge, repo.path)),
    )
    .map(([key]) => key)

  const traits: Traits = {}
  for (const [pattern, entry] of Object.entries(config.repos)) {
    if ((!entry.forge || entry.forge === repo.forge) && new Bun.Glob(pattern).match(repo.path)) {
      Object.assign(traits, entry.traits)
    }
  }

  return { repo, teams, consumers, traits }
}
