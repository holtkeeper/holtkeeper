import type { GroupDocumentData, RepoRef } from '@holtkeeper/api'

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

/** Checks a repository path as the forge shows it (`team/app`); an error message or `undefined`. */
export function validateRepoPath(path: string): string | undefined {
  const value = path.trim()
  if (!value) return 'Enter the repository path'
  if (/\s/.test(value)) return 'Paths cannot contain spaces'
  if (value.startsWith('/') || value.endsWith('/')) return 'No leading or trailing "/"'
  if (/[*?[\]{}]/.test(value)) return 'Use an exact path; edit the group for patterns'
  if (!value.includes('/')) return 'Include the namespace: team/app'
  return undefined
}

/** Checks a new group id: lowercase letters, digits and dashes, starting with a letter. */
export const validateGroupId = (id: string): string | undefined =>
  /^[a-z][a-z0-9-]*$/.test(id.trim()) ? undefined : 'Lowercase letters, digits and dashes'

/** A group's data with `path` included (and no longer excluded); a new group when there is none. */
export function withRepo(
  group: GroupDocumentData | undefined,
  forge: string,
  path: string,
): GroupDocumentData {
  if (!group) return { forge, include: [path], exclude: [] }
  return {
    forge: group.forge,
    include: group.include.includes(path) ? group.include : [...group.include, path],
    exclude: group.exclude.filter((pattern) => pattern !== path),
  }
}
