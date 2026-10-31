import type { LibraryChunk, LibraryRef } from '@holtkeeper/store'

import type { GitHubClient } from '../github/client.ts'
import { documentChunks } from '../markdown.ts'
import { compareSemver } from '../semver.ts'
import { versionOfTag } from '../tags.ts'

/** The fields of a GitHub release this package reads. */
export interface GitHubRelease {
  tag_name: string
  name?: string | null
  body?: string | null
  draft?: boolean
  prerelease?: boolean
  html_url?: string
  published_at?: string | null
}

/** Published releases of a GitHub repository (`owner/name`), newest first, up to `maxPages` of 100. */
export async function listReleases(
  github: GitHubClient,
  path: string,
  maxPages = 10,
): Promise<GitHubRelease[]> {
  const releases: GitHubRelease[] = []
  let next: string | undefined = `/repos/${path}/releases?per_page=100`
  for (let page = 0; next && page < maxPages; page++) {
    // oxlint-disable-next-line no-await-in-loop -- pages follow each other
    const response: Awaited<ReturnType<typeof github.rest<GitHubRelease[]>>> =
      await github.rest<GitHubRelease[]>(next)
    releases.push(...(response.data ?? []).filter((release) => !release.draft && release.tag_name))
    next = response.next
  }
  return releases
}

/** A release with the version its tag names. */
export interface VersionedRelease {
  version: string
  release: GitHubRelease
}

/**
 * Releases of `name` by indexed version: each release goes to the lowest indexed version at or
 * above the one its tag names, so a version carries the notes since the indexed version below
 * it. Releases above every indexed version or below the lowest one are dropped, as are tags of
 * other packages.
 */
export function assignReleases(
  releases: readonly GitHubRelease[],
  versions: readonly string[],
  name: string,
  directory?: string,
): Map<string, VersionedRelease[]> {
  const ascending = [...versions].toSorted(compareSemver)
  const lowest = ascending[0]
  const assigned = new Map<string, VersionedRelease[]>(ascending.map((version) => [version, []]))
  for (const release of releases) {
    const version = versionOfTag(release.tag_name, name, directory)
    if (!version || !lowest || compareSemver(version, lowest) < 0) continue
    const home = ascending.find((candidate) => compareSemver(candidate, version) >= 0)
    if (home) assigned.get(home)?.push({ version, release })
  }
  for (const list of assigned.values()) list.sort((a, b) => compareSemver(b.version, a.version))
  return assigned
}

/** Path of a release's chunks: `releases/<tag>`. */
export const releasePath = (tag: string) => `releases/${tag}`

/** The tag of a release chunk path, or `undefined` for other paths. */
export const tagOfReleasePath = (path: string) =>
  path.startsWith('releases/') ? path.slice('releases/'.length) : undefined

/** Chunks of one release's notes, headed by its name (or tag). */
export function releaseChunks(
  ref: LibraryRef,
  release: GitHubRelease,
): Omit<LibraryChunk, 'versions'>[] {
  const title = release.name?.trim() || release.tag_name
  const body = release.body?.trim()
  if (!body) return []
  return documentChunks(ref, 'releases', releasePath(release.tag_name), body, {
    prefix: [title],
    ...(release.html_url ? { url: release.html_url } : {}),
  })
}
