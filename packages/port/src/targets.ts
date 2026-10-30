import type { GitForge, RepoRef } from '@holtkeeper/forge'
import { globToRegExp } from '@holtkeeper/propagate'

const isGlob = (pattern: string) => /[*?[\]{}]/.test(pattern)

/** Input of `resolveTargets`. */
export interface ResolveTargetsInput {
  /** Globs or names from options or the command line; empty means every repository of the group. */
  patterns: string[]
  /** Name of the group the analyzer runs for (`context.repo.path`). */
  group: string
  repos: RepoRef[]
  /** Source repository path; never a target. */
  source: string
  forge?: GitForge
  forgeId: string
}

/**
 * Turns target arguments into repositories. A glob matches repository paths. A bare name is a
 * repository path when one matches, the group itself when it equals `group`, and otherwise a
 * namespace: `games` becomes `games/*` when group repositories live under it, or the forge's
 * repositories of that namespace (`listRepositories`) when none do. The source is left out.
 */
export async function resolveTargets(input: ResolveTargetsInput): Promise<RepoRef[]> {
  const candidates = new Map(input.repos.map((repo) => [repo.path, repo]))
  const globs: string[] = []
  if (input.patterns.length === 0) globs.push('**')
  for (const pattern of input.patterns
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter(Boolean)) {
    if (isGlob(pattern) || candidates.has(pattern)) globs.push(pattern)
    else if (pattern === input.group) globs.push('**')
    else if (input.repos.some((repo) => repo.path.startsWith(`${pattern}/`)))
      globs.push(`${pattern}/*`)
    else if (input.forge) {
      // oxlint-disable-next-line no-await-in-loop -- namespaces are listed one after another
      for await (const repository of input.forge.listRepositories(pattern)) {
        candidates.set(repository.path, { forge: input.forgeId, path: repository.path })
        globs.push(repository.path)
      }
    }
  }
  const matchers = globs.map(globToRegExp)
  return [...candidates.values()]
    .filter(
      (repo) => repo.path !== input.source && matchers.some((matcher) => matcher.test(repo.path)),
    )
    .toSorted((a, b) => a.path.localeCompare(b.path))
}
