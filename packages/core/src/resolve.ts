import type { RepoRef } from '@holtkeeper/forge'

import type { HoltkeeperConfig } from './config.ts'

/** Facts about a repository from the config's `repos`, such as `{ ssr: false }`. */
export type Traits = Record<string, string | number | boolean>

export interface ResolvedRepo {
  repo: RepoRef
  groups: string[]
  traits: Traits
}

const matches = (pattern: string, path: string) => new Bun.Glob(pattern).match(path)
const matchesAny = (patterns: string[], path: string) => patterns.some((p) => matches(p, path))

/** What applies to a repository: the groups it belongs to and its merged traits. */
export function resolveRepo(config: HoltkeeperConfig, repo: RepoRef): ResolvedRepo {
  const groups = Object.entries(config.groups)
    .filter(
      ([, group]) =>
        group.forge === repo.forge &&
        matchesAny(group.include, repo.path) &&
        !matchesAny(group.exclude, repo.path),
    )
    .map(([name]) => name)

  const traits: Traits = {}
  for (const [pattern, entry] of Object.entries(config.repos)) {
    if ((!entry.forge || entry.forge === repo.forge) && matches(pattern, repo.path)) {
      Object.assign(traits, entry.traits)
    }
  }

  return { repo, groups, traits }
}
