import { compareVersions, isVersion } from './version.ts'

/** A tag that versions one package of a monorepo rather than the whole repository. */
export interface PackageTag {
  tag: string
  package: string
  version: string
}

const separators = ['@', '/', '-'] as const

/**
 * Reads tags that monorepo release tools create per package: `@scope/name@1.2.3` and
 * `name@1.2.3` (changesets, lerna), `path/to/module/v1.2.3` (Go modules), `name-v1.2.3`
 * (release-please). Plain versions such as `v1.2.3` are not package tags.
 */
export function parsePackageTag(tag: string): PackageTag | undefined {
  for (const separator of separators) {
    const at = tag.lastIndexOf(separator)
    if (at <= 0) continue
    const version = tag.slice(at + 1)
    if (separator === '-' && !version.startsWith('v')) continue
    if (!isVersion(version)) continue
    return { tag, package: tag.slice(0, at), version }
  }
  return undefined
}

/** Whether a tag versions one package of a monorepo; see `parsePackageTag`. */
export const isPackageTag = (tag: string) => parsePackageTag(tag) !== undefined

/**
 * What a release job targets for a tag: the tagged commit for package tags, so every package
 * released by one commit becomes one release, and the tag itself otherwise.
 */
export const releaseTarget = (tag: { name: string; sha: string }) =>
  isPackageTag(tag.name) ? tag.sha : tag.name

/** Orders package tags by package name, then newest version first. */
export const comparePackageTags = (a: PackageTag, b: PackageTag) =>
  a.package.localeCompare(b.package) ||
  compareVersions(b.version, a.version) ||
  a.tag.localeCompare(b.tag)
