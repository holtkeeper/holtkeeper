import type { RepoRef } from '@holtkeeper/api'

/** `forge:path`, the form the API uses in query strings and activity subjects. */
export const repoKey = (repo: RepoRef): string => `${repo.forge}:${repo.path}`

/** Parses `forge:path`; `undefined` when there is no forge prefix or path. */
export function parseRepoKey(key: string | undefined): RepoRef | undefined {
  if (!key) return undefined
  const separator = key.indexOf(':')
  if (separator <= 0 || separator === key.length - 1) return undefined
  return { forge: key.slice(0, separator), path: key.slice(separator + 1) }
}

/** Last path segment, for compact labels. */
export const repoName = (repo: RepoRef): string => repo.path.split('/').at(-1) ?? repo.path
