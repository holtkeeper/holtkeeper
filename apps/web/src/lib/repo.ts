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

/** `team/sub/app` → namespace `team/sub/` and name `app`, for two-tone labels. */
export function splitRepoPath(path: string): { namespace: string; name: string } {
  const slash = path.lastIndexOf('/')
  return slash < 0
    ? { namespace: '', name: path }
    : { namespace: path.slice(0, slash + 1), name: path.slice(slash + 1) }
}

/** How recent an audit is: within a week, within a month, older, or never. */
export type Freshness = 'fresh' | 'aging' | 'stale' | 'never'

export function auditFreshness(finishedAt: string | undefined, now: Date = new Date()): Freshness {
  if (!finishedAt) return 'never'
  const days = (now.getTime() - new Date(finishedAt).getTime()) / 86_400_000
  return days <= 7 ? 'fresh' : days <= 30 ? 'aging' : 'stale'
}

const firstLetter = (segment: string | undefined) =>
  (segment?.match(/[\p{L}\p{N}]/u)?.[0] ?? '').toUpperCase()

/**
 * Two letters for a repository, the same the server draws on generated avatars: the first of its
 * parent and of its name, or the first two words of a top-level name.
 */
export function repoInitials(path: string): string {
  const segments = path.split('/').filter(Boolean)
  const name = segments.at(-1) ?? ''
  if (segments.length > 1) return `${firstLetter(segments.at(-2))}${firstLetter(name)}` || '?'
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  return (
    (words.length > 1
      ? `${firstLetter(words[0])}${firstLetter(words[1])}`
      : name.slice(0, 2).toUpperCase()) || '?'
  )
}
