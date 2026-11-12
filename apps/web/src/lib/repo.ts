import type { GroupDocumentData, RepoAccessResult, RepoRef } from '@holtkeeper/api'

import type { DotTone } from '../ui/Legend.tsx'

/** `forge:path`, the form the API uses in query strings and audit targets. */
export const repoKey = (repo: RepoRef): string => `${repo.forge}:${repo.path}`

/** Parses `forge:path`; `undefined` when there is no forge prefix or path. */
export function parseRepoKey(key: string | undefined): RepoRef | undefined {
  if (!key) return undefined
  const separator = key.indexOf(':')
  if (separator <= 0 || separator === key.length - 1) return undefined
  return { forge: key.slice(0, separator), path: key.slice(separator + 1) }
}

/** `forge/path`, the splat of the repository hub route `/repos/$`. */
export const repoSplat = (repo: RepoRef): string => `${repo.forge}/${repo.path}`

/** Parses a hub splat `forge/path`; `undefined` without a forge segment or path. */
export function parseRepoSplat(splat: string | undefined): RepoRef | undefined {
  const value = splat?.replace(/^\/+|\/+$/g, '')
  if (!value) return undefined
  const separator = value.indexOf('/')
  if (separator <= 0) return undefined
  const path = value.slice(separator + 1).replace(/^\/+/, '')
  return path ? { forge: value.slice(0, separator), path } : undefined
}

const repoHubTabs = [
  'overview',
  'supply',
  'quality',
  'releases',
  'activity',
  'knowledge',
  'settings',
] as const

/** Tabs of the repository hub, in display order; `overview` is the default. */
export type RepoHubTab = (typeof repoHubTabs)[number]

/**
 * Search parameters of the repository hub: a tab, an area of it (`section`, e.g. `assets` or
 * `updates`), and a file at a ref for areas that show one.
 */
export interface RepoHubSearch {
  tab?: RepoHubTab
  section?: string
  file?: string
  ref?: string
}

/** Whether `value` names a hub tab. */
export const isRepoHubTab = (value: unknown): value is RepoHubTab =>
  repoHubTabs.some((tab) => tab === value)

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

/** The hub's search parameters from a URL; unknown tabs and empty values are dropped. */
export function parseRepoHubSearch(search: Record<string, unknown>): RepoHubSearch {
  const section = text(search.section)
  const file = text(search.file)
  const ref = text(search.ref)
  return {
    ...(isRepoHubTab(search.tab) ? { tab: search.tab } : {}),
    ...(section ? { section } : {}),
    ...(file ? { file } : {}),
    ...(ref ? { ref } : {}),
  }
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

/**
 * Checks an id of a forge, a schedule or a root group, or the part of a subgroup key after the dot:
 * lowercase letters, digits and dashes, starting with a letter. Whole group keys go through
 * `validateGroupKey`.
 */
export const validateGroupId = (id: string): string | undefined =>
  /^[a-z][a-z0-9-]*$/.test(id.trim()) ? undefined : 'Lowercase letters, digits and dashes'

/** A group's data with `paths` included (and no longer excluded); a new group when there is none. */
export function withRepos(
  group: GroupDocumentData | undefined,
  forge: string,
  paths: readonly string[],
): GroupDocumentData {
  if (!group) return { forge, include: [...new Set(paths)], exclude: [] }
  return {
    ...group,
    include: [...new Set([...group.include, ...paths])],
    exclude: group.exclude.filter((pattern) => !paths.includes(pattern)),
  }
}

/** A config group as the panel stores it. */
interface GroupEntry {
  id: string
  data: GroupDocumentData
}

const groupDocument = ({
  title,
  forge,
  include,
  exclude,
}: GroupDocumentData): GroupDocumentData => ({
  ...(title !== undefined && { title }),
  forge,
  include,
  exclude,
})

const globSyntax = /[*?[\]{}]/

/**
 * The group documents to save to move `path` into subgroup `to`: the target includes it (and no
 * longer excludes it), and each subgroup in `from` lets it go. A source that names `path` as an
 * exact include path drops it; one that could still match it through a glob, or would be left
 * without include patterns, excludes it. Groups missing from `groups` are skipped.
 */
export function moveToSubgroup(
  groups: readonly GroupEntry[],
  path: string,
  from: string | readonly string[] | undefined,
  to: string,
): GroupEntry[] {
  const changed: GroupEntry[] = []
  const target = groups.find((entry) => entry.id === to)
  if (target)
    changed.push({ id: to, data: groupDocument(withRepos(target.data, target.data.forge, [path])) })
  const sources = from === undefined ? [] : typeof from === 'string' ? [from] : from
  for (const id of new Set(sources)) {
    const source = groups.find((entry) => entry.id === id)
    if (!source || id === to) continue
    const rest = source.data.include.filter((pattern) => pattern !== path)
    const include = rest.length ? rest : source.data.include
    const exclude = include.includes(path) || include.some((pattern) => globSyntax.test(pattern))
    changed.push({
      id,
      data: groupDocument({
        ...source.data,
        include,
        exclude: exclude ? [...new Set([...source.data.exclude, path])] : source.data.exclude,
      }),
    })
  }
  return changed
}

/**
 * A new subgroup `<parent>.<key>` of `parent`: on the parent's forge, including `patterns` (exact
 * paths of the parent's members and globs), with `title` when one is given.
 */
export function subgroupDraft(
  parent: GroupEntry,
  key: string,
  title: string,
  patterns: readonly string[],
): GroupEntry {
  const name = title.trim()
  return {
    id: `${parent.id}.${key.trim()}`,
    data: {
      ...(name && { title: name }),
      forge: parent.data.forge,
      include: [...new Set(patterns.map((pattern) => pattern.trim()).filter(Boolean))],
      exclude: [],
    },
  }
}

/** Paths pasted into the add wizard, read line by line. */
export interface PastedPaths {
  /** Distinct valid paths in the order pasted. */
  paths: string[]
  /** Paths that were trimmed from a forge URL. */
  fromUrl: string[]
  /** Lines that are no repository path, with the reason. */
  invalid: { line: string; error: string }[]
}

const urlPath = (line: string): string | undefined => {
  const ssh = /^[\w.-]+@[\w.-]+:(.+)$/.exec(line)
  if (ssh) return ssh[1]
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) return undefined
  let url: URL
  try {
    url = new URL(line)
  } catch {
    return undefined
  }
  const segments = url.pathname.split('/-/')[0]?.split('/').filter(Boolean) ?? []
  return (url.hostname === 'github.com' ? segments.slice(0, 2) : segments).join('/')
}

/**
 * Repository paths from pasted text: one per line (commas and spaces separate too), forge URLs and
 * SSH clone addresses trimmed to their path (GitLab's `/-/…` and a `.git` suffix dropped), blank
 * lines and repeats skipped, anything else that is no exact `team/app` path reported as invalid.
 */
export function parsePastedPaths(pasted: string): PastedPaths {
  const paths: string[] = []
  const fromUrl: string[] = []
  const invalid: PastedPaths['invalid'] = []
  for (const line of pasted.split(/[\s,]+/)) {
    const value = line.trim()
    if (!value) continue
    const trimmed = urlPath(value)
    const path = (trimmed ?? value).replace(/\.git$/, '').replace(/^\/+|\/+$/g, '')
    const error = validateRepoPath(path)
    if (error) invalid.push({ line: value, error })
    else if (!paths.includes(path)) {
      paths.push(path)
      if (trimmed !== undefined) fromUrl.push(path)
    }
  }
  return { paths, fromUrl, invalid }
}

/** `team/sub/app` → namespace `team/sub/` and name `app`, for two-tone labels. */
export function splitRepoPath(path: string): { namespace: string; name: string } {
  const slash = path.lastIndexOf('/')
  return slash < 0
    ? { namespace: '', name: path }
    : { namespace: path.slice(0, slash + 1), name: path.slice(slash + 1) }
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

/** What the add wizard says about one checked path. */
export interface PathCheck {
  label: string
  tone: DotTone
  /** Why, or what to do about it. */
  why: string
  /** Whether the path can be added. */
  ready: boolean
}

/**
 * The verdict on one path of the add wizard: already added paths are skipped; otherwise the access
 * check decides, naming whom to invite (`account`, the forge token's account) when the token cannot
 * see the path. A check the forge could not answer still lets the path be added.
 */
export function pathCheck(
  result: RepoAccessResult | undefined,
  options: { added?: boolean; fromUrl?: boolean; account?: { username: string } } = {},
): PathCheck {
  const who = options.account ? `@${options.account.username}` : 'the account of the forge token'
  if (options.added)
    return {
      label: 'Already added',
      tone: 'none',
      why: 'Holtkeeper works on it already',
      ready: false,
    }
  if (!result)
    return {
      label: 'Not checked',
      tone: 'none',
      why: options.fromUrl ? 'Trimmed from a forge URL' : 'Checked when you continue',
      ready: false,
    }
  switch (result.status) {
    case 'ok':
      return {
        label: 'Readable',
        tone: 'success',
        why: options.fromUrl ? 'Trimmed from a forge URL' : `Through ${who}`,
        ready: true,
      }
    case 'not-found':
      return {
        label: 'Not found',
        tone: 'danger',
        why: `It does not exist or ${who} is not a member; invite it as Reporter (Developer to open merge requests)`,
        ready: false,
      }
    case 'unauthorized':
      return {
        label: 'Token rejected',
        tone: 'danger',
        why: 'The forge token is invalid, revoked or expired; replace it in Integrations',
        ready: false,
      }
    case 'forbidden':
      return {
        label: 'No access',
        tone: 'warning',
        why: `Give the token the api or read_api scope, or ${who} a role in the project`,
        ready: false,
      }
    case 'archived':
      return {
        label: 'Archived',
        tone: 'warning',
        why: 'Holtkeeper skips archived repositories; unarchive it first',
        ready: false,
      }
  }
  return {
    label: 'Not checked',
    tone: 'warning',
    why: result.message ?? 'The forge did not answer; it can still be added',
    ready: true,
  }
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    previous = current
  }
  return previous[b.length] ?? 0
}

/**
 * "Did you mean" for an address that names no repository: up to `limit` of `repos` (only those the
 * viewer can see) whose `forge:path`, path or name is a few typos away from `wanted`, closest
 * first. An exact match is not a suggestion.
 */
export function suggestRepos(wanted: string, repos: readonly RepoRef[], limit = 3): RepoRef[] {
  const needle = wanted
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase()
  if (!needle) return []
  const allowed = Math.max(2, Math.floor(needle.length / 3))
  return repos
    .flatMap((repo) => {
      const forms = [repoKey(repo), repo.path, repoName(repo)].map((form) => form.toLowerCase())
      if (forms[0] === needle || forms[1] === needle) return []
      const distance = Math.min(...forms.map((form) => editDistance(needle, form)))
      return distance <= allowed ? [{ repo, distance }] : []
    })
    .toSorted((a, b) => a.distance - b.distance || a.repo.path.localeCompare(b.repo.path))
    .slice(0, limit)
    .map((entry) => entry.repo)
}
