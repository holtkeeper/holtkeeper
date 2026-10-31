import type { LibraryRepository } from '@holtkeeper/store'

import type { GitHubClient } from './github/client.ts'
import { parseSemver, sameVersion } from './semver.ts'

/** Where a version's code is: the tag when one was found, the commit when known, and the ref to fetch. */
export interface ResolvedTag {
  tag?: string
  commit?: string
  /** Tag, else commit; what `/tarball/{ref}` takes. */
  ref?: string
}

/** Repository of a library and the names its tags may carry. */
export interface TagTarget {
  repository: LibraryRepository
  /** Package name (npm) or module path (Go). */
  name: string
  version: string
  /** Commit the registry names (npm `gitHead`). */
  commit?: string
}

/** Prefixes a tag of `name` may carry before the version, most common first. */
export function tagPrefixes(name: string, directory?: string): string[] {
  const short = name.split('/').at(-1) ?? name
  const prefixes = ['v', '', `${name}@`, `${name}-v`, `${short}@`, `${short}-v`]
  if (directory) prefixes.push(`${directory}/v`)
  return [...new Set(prefixes)]
}

/**
 * Tag names version `version` of `name` may have: `v<version>`, `<version>`, `<name>@<version>`,
 * `<name>-v<version>`, the same with the last segment of a scoped name, and `<directory>/v<version>`
 * for packages in a repository folder (Go submodules).
 */
export function tagCandidates(name: string, version: string, directory?: string): string[] {
  const bare = version.replace(/^v/, '')
  return [...new Set(tagPrefixes(name, directory).map((prefix) => `${prefix}${bare}`))]
}

/** The version a tag names for `name`, or `undefined` when the tag belongs to something else. */
export function versionOfTag(tag: string, name: string, directory?: string): string | undefined {
  for (const prefix of tagPrefixes(name, directory).toSorted((a, b) => b.length - a.length)) {
    if (!tag.startsWith(prefix)) continue
    const rest = tag.slice(prefix.length)
    if (parseSemver(rest) && !rest.startsWith('v')) return rest
  }
  return undefined
}

/** A tag or branch for a URL path: each `/`-separated segment encoded, the slashes kept. */
export const encodeRef = (ref: string) => ref.split('/').map(encodeURIComponent).join('/')

/** `owner/repo` of a GitHub repository, or `undefined` for other hosts. */
export const githubPath = (repository: LibraryRepository | undefined) =>
  repository?.host === 'github.com' ? repository.path : undefined

interface GitTag {
  name: string
  commit?: { sha?: string }
}

/**
 * Finds tags of versions on GitHub. Lists a repository's tags once (up to `maxPages` pages of 100)
 * and checks candidates against that list; when the list was cut off, asks
 * `/git/ref/tags/{tag}` for each candidate. A commit from the registry is kept even without a tag.
 */
export function tagResolver(github: GitHubClient, options: { maxPages?: number } = {}) {
  const maxPages = options.maxPages ?? 10
  const listings = new Map<string, Promise<{ tags: Map<string, string>; complete: boolean }>>()

  const list = (path: string) => {
    let pending = listings.get(path)
    if (!pending) {
      pending = (async () => {
        const tags = new Map<string, string>()
        let next: string | undefined = `/repos/${path}/tags?per_page=100`
        let pages = 0
        while (next && pages < maxPages) {
          // oxlint-disable-next-line no-await-in-loop -- pages follow each other
          const response: Awaited<ReturnType<typeof github.rest<GitTag[]>>> =
            await github.rest<GitTag[]>(next)
          for (const tag of response.data ?? [])
            if (tag.name) tags.set(tag.name, tag.commit?.sha ?? '')
          next = response.next
          pages += 1
        }
        return { tags, complete: next === undefined }
      })()
      listings.set(path, pending)
      pending.catch(() => listings.delete(path))
    }
    return pending
  }

  return async (target: TagTarget): Promise<ResolvedTag> => {
    const path = githubPath(target.repository)
    const fallback = target.commit ? { commit: target.commit, ref: target.commit } : {}
    if (!path) return fallback
    const candidates = tagCandidates(target.name, target.version, target.repository.directory)
    const { tags, complete } = await list(path)
    const listed = candidates.find((candidate) => tags.has(candidate))
    if (listed) {
      const sha = tags.get(listed) || undefined
      const commit = target.commit ?? sha
      return { tag: listed, ...(commit ? { commit } : {}), ref: listed }
    }
    const loose = [...tags.keys()].find((tag) =>
      sameVersion(
        versionOfTag(tag, target.name, target.repository.directory) ?? '',
        target.version,
      ),
    )
    if (loose) {
      const commit = target.commit ?? (tags.get(loose) || undefined)
      return { tag: loose, ...(commit ? { commit } : {}), ref: loose }
    }
    if (complete) return fallback
    for (const candidate of candidates) {
      // oxlint-disable-next-line no-await-in-loop -- stop at the first tag that exists
      const response = await github.rest<{ object?: { sha?: string; type?: string } }>(
        `/repos/${path}/git/ref/tags/${encodeRef(candidate)}`,
      )
      if (response.status === 404 || !response.data) continue
      const commit =
        target.commit ??
        (response.data.object?.type === 'commit' ? response.data.object.sha : undefined)
      return { tag: candidate, ...(commit ? { commit } : {}), ref: candidate }
    }
    return fallback
  }
}

/** Resolves the tag and commit of one version; see `tagResolver`. */
export type TagResolver = ReturnType<typeof tagResolver>
