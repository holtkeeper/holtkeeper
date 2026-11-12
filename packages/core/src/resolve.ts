import { parentGroup } from '@holtkeeper/access'
import type { RepoRef } from '@holtkeeper/forge'

import type { HoltkeeperConfig } from './config.ts'

/** Facts about a repository from the config's `repos`, such as `{ ssr: false }`. */
export type Traits = Record<string, string | number | boolean>

export interface ResolvedRepo {
  repo: RepoRef
  /**
   * Every group the repository is in, each subgroup listed directly before its parent. A
   * repository is in a subgroup only when it is also in the parent, so the list always holds the
   * full lineage of each group.
   */
  groups: string[]
  traits: Traits
}

const matches = (pattern: string, path: string) => new Bun.Glob(pattern).match(path)
const matchesAny = (patterns: string[], path: string) => patterns.some((p) => matches(p, path))

/** What applies to a repository: the groups it belongs to and its merged traits. */
export function resolveRepo(config: HoltkeeperConfig, repo: RepoRef): ResolvedRepo {
  const matched = new Set(
    Object.entries(config.groups)
      .filter(
        ([, group]) =>
          group.forge === repo.forge &&
          matchesAny(group.include, repo.path) &&
          !matchesAny(group.exclude, repo.path),
      )
      .map(([name]) => name),
  )
  const member = (name: string): boolean => {
    const parent = parentGroup(name)
    return matched.has(name) && (parent === undefined || member(parent))
  }
  const groups: string[] = []
  for (const name of Object.keys(config.groups)) {
    if (!member(name) || parentGroup(name) !== undefined) continue
    for (const sub of Object.keys(config.groups)) {
      if (parentGroup(sub) === name && member(sub)) groups.push(sub)
    }
    groups.push(name)
  }

  const traits: Traits = {}
  for (const [pattern, entry] of Object.entries(config.repos)) {
    if ((!entry.forge || entry.forge === repo.forge) && matches(pattern, repo.path)) {
      Object.assign(traits, entry.traits)
    }
  }

  return { repo, groups, traits }
}
