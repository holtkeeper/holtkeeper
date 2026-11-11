import type { RepoFilter } from '../api-surface/catalog.ts'

/** `forge:path` of a repository. */
export const repoKey = (repo: { forge: string; path: string }) => `${repo.forge}:${repo.path}`

/** `repo` when it is a `forge:path` the caller may read, else `undefined`. */
export function readableRepo(canRead: RepoFilter, repo: string | undefined): string | undefined {
  if (!repo) return undefined
  const separator = repo.indexOf(':')
  if (separator < 1) return undefined
  return canRead({ forge: repo.slice(0, separator), path: repo.slice(separator + 1) })
    ? repo
    : undefined
}
