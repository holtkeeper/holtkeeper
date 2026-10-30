import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { RepoRef } from '@holtkeeper/forge'

/** Repositories of one config group, as the scheduler sees them. */
export type ResolveRepos = (group: string) => Promise<RepoRef[]>

const globChars = /[*?[{]/

/** The namespace to list for an include glob: everything before its first wildcard segment. */
export function staticPrefix(pattern: string): string {
  const segments = pattern.split('/')
  const index = segments.findIndex((segment) => globChars.test(segment))
  return (index === -1 ? segments : segments.slice(0, index)).join('/')
}

const matches = (patterns: string[], path: string) =>
  patterns.some((pattern) => new Bun.Glob(pattern).match(path))

/**
 * Lists a group's repositories from its forge: every include glob's static prefix is listed with
 * `GitForge.listRepositories`, then filtered by the include and exclude globs. Archived
 * repositories are skipped. Throws for unknown groups.
 */
export function groupRepositories(config: HoltkeeperConfig): ResolveRepos {
  return async (name) => {
    const group = config.groups[name]
    if (!group) throw new Error(`unknown group "${name}"`)
    const definition = config.forges[group.forge]
    if (!definition) throw new Error(`unknown forge "${group.forge}"`)
    const forge = definition.create()
    const found = new Map<string, RepoRef>()
    for (const namespace of new Set(group.include.map(staticPrefix))) {
      for await (const repository of forge.listRepositories(namespace)) {
        if (repository.archived) continue
        if (!matches(group.include, repository.path) || matches(group.exclude, repository.path))
          continue
        found.set(repository.path, { forge: group.forge, path: repository.path })
      }
    }
    return [...found.values()].toSorted((a, b) => a.path.localeCompare(b.path))
  }
}

/** Whether `repo` matches a `forge:path` glob such as `work:games/*`. */
export function matchesRepoGlob(pattern: string, repo: RepoRef): boolean {
  const separator = pattern.indexOf(':')
  return (
    pattern.slice(0, separator) === repo.forge &&
    new Bun.Glob(pattern.slice(separator + 1)).match(repo.path)
  )
}
