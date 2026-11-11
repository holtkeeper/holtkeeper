import { dateParts } from './dates.ts'
import type { Bump, ReleaseSettings } from './settings.ts'

/** A tag that names a version under the repository's tag format. */
export interface VersionTag {
  tag: string
  version: string
  sha: string
  /** ISO 8601 when the forge reports it. */
  date?: string
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

const bumpRank: Record<Bump, number> = { none: 0, patch: 1, minor: 2, major: 3 }

/** The larger of two bumps. */
export const maxBump = (a: Bump, b: Bump): Bump => (bumpRank[a] >= bumpRank[b] ? a : b)

/** Tag name of a version under `format`, e.g. `v{version}` → `v1.2.3`. */
export const tagName = (format: string, version: string) => format.replace('{version}', version)

/** The version a tag names under `format`, or `undefined` when the tag does not follow it. */
export function versionOfTag(format: string, tag: string): string | undefined {
  const [prefix = '', suffix = ''] = format.split('{version}')
  if (!tag.startsWith(prefix) || !tag.endsWith(suffix)) return undefined
  const version = tag.slice(prefix.length, tag.length - suffix.length)
  return version.length > 0 ? version : undefined
}

function calverPattern(format: string): RegExp {
  const tokens: Record<string, string> = {
    YYYY: '\\d{4}',
    YY: '\\d{2}',
    '0M': '\\d{2}',
    MM: '\\d{1,2}',
    '0D': '\\d{2}',
    DD: '\\d{1,2}',
    MICRO: '\\d+',
  }
  const source = format
    .split(/(YYYY|YY|0M|MM|0D|DD|MICRO)/u)
    .map((part) => tokens[part] ?? escape(part))
    .join('')
  return new RegExp(`^${source}(?:-[0-9A-Za-z.-]+)?$`, 'u')
}

/** Calendar version format: year, month without padding, a counter within the month. */
export const calverFormat = 'YYYY.MM.MICRO'

/** First semantic version when a repository has no version tag yet. */
export const initialVersion = '0.1.0'

/** Pre-release channel when `version.prerelease` is on. */
export const prereleaseChannel = 'rc'

const calverMatcher = calverPattern(calverFormat)

/** Whether `version` is valid under the settings' scheme. */
export function isValidVersion(settings: ReleaseSettings, version: string): boolean {
  return settings.version.scheme === 'semver' ? SEMVER.test(version) : calverMatcher.test(version)
}

const calverKey = (version: string) =>
  version
    .split('-')[0]!
    .split(/\D+/u)
    .filter(Boolean)
    .map((part) => part.padStart(6, '0'))
    .join('.')

const preOf = (version: string) => version.slice(version.indexOf('-') + 1)

/** Orders two versions of the settings' scheme; pre-releases sort before their release. */
export function compareSchemeVersions(settings: ReleaseSettings, a: string, b: string): number {
  if (settings.version.scheme === 'semver') return compareVersions(a, b)
  const order = calverKey(a).localeCompare(calverKey(b))
  if (order !== 0) return order
  if (a.includes('-') && b.includes('-'))
    return compareVersions(`0.0.0-${preOf(a)}`, `0.0.0-${preOf(b)}`)
  return Number(b.includes('-')) - Number(a.includes('-'))
}

/**
 * Tags that follow the tag format and name a valid version, newest version first. Tags of other
 * shapes (other tools, package tags of monorepos) are left out.
 */
export function versionTags(
  settings: ReleaseSettings,
  tags: readonly { name: string; sha: string; committedAt?: string; createdAt?: string }[],
): VersionTag[] {
  return tags
    .flatMap((tag) => {
      const version = versionOfTag(settings.version.tagFormat, tag.name)
      if (!version || !isValidVersion(settings, version)) return []
      const date = tag.createdAt ?? tag.committedAt
      return [{ tag: tag.name, version, sha: tag.sha, ...(date ? { date } : {}) }]
    })
    .toSorted((a, b) => compareSchemeVersions(settings, b.version, a.version))
}

/** The newest released version; pre-releases count only when `prerelease` is on. */
export function latestVersion(
  settings: ReleaseSettings,
  tags: readonly VersionTag[],
): VersionTag | undefined {
  return tags.find((tag) => settings.version.prerelease || !tag.version.includes('-'))
}

/** `major.minor.patch` of a semantic version, or `undefined`. */
export function parseSemver(version: string) {
  const match = SEMVER.exec(version)
  if (!match) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4],
  }
}

/** `version` raised by `bump`; `none` keeps it. Pre-release parts are dropped. */
export function bumpSemver(version: string, bump: Bump): string {
  const parsed = parseSemver(version)
  if (!parsed) throw new Error(`${version} is not a semantic version`)
  const { major, minor, patch, pre } = parsed
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  if (bump === 'patch') return pre ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`
  return `${major}.${minor}.${patch}`
}

function nextCalver(format: string, previous: string | undefined, now: Date) {
  const parts = dateParts(now)
  const values: Record<string, string> = {
    YYYY: parts.year,
    YY: parts.year.slice(2),
    '0M': parts.month,
    MM: String(Number(parts.month)),
    '0D': parts.day,
    DD: String(Number(parts.day)),
  }
  const pieces = format.split(/(YYYY|YY|0M|MM|0D|DD|MICRO)/u)
  const tokens = pieces.filter((_, index) => index % 2 === 1)
  const matcher = new RegExp(
    `^${pieces.map((piece, index) => (index % 2 === 1 ? '(\\d+)' : escape(piece))).join('')}$`,
    'u',
  )
  const match = matcher.exec(previous?.split('-')[0] ?? '')
  const samePeriod =
    match !== null &&
    tokens.every(
      (token, index) => token === 'MICRO' || Number(match[index + 1]) === Number(values[token]),
    )
  const micro = samePeriod ? Number(match[tokens.indexOf('MICRO') + 1]) + 1 : 0
  const next = pieces
    .map((piece, index) =>
      index % 2 === 0 ? piece : piece === 'MICRO' ? String(micro) : values[piece]!,
    )
    .join('')
  return { next, samePeriod }
}

function withPrerelease(
  settings: ReleaseSettings,
  core: string,
  tags: readonly VersionTag[],
): string {
  if (!settings.version.prerelease) return core
  const prefix = `${core}-${prereleaseChannel}.`
  const numbers = tags
    .filter((tag) => tag.version.startsWith(prefix))
    .map((tag) => Number(tag.version.slice(prefix.length)))
    .filter(Number.isInteger)
  return `${prefix}${numbers.length ? Math.max(...numbers) + 1 : 1}`
}

/**
 * The version after `current` for `bump`: semantic versions start at `initialVersion`, calendar
 * versions follow the UTC date (`calverFormat`). With `version.prerelease` the result is the next
 * release candidate of that version. `undefined` when `bump` is `none`.
 */
export function nextVersion(
  settings: ReleaseSettings,
  current: string | undefined,
  bump: Bump,
  tags: readonly VersionTag[],
  now: Date,
): string | undefined {
  if (bump === 'none') return undefined
  if (settings.version.scheme === 'calver') {
    const released = current?.split('-')[0]
    const { next, samePeriod } = nextCalver(calverFormat, released, now)
    if (released && current !== released && samePeriod && settings.version.prerelease)
      return withPrerelease(settings, released, tags)
    return withPrerelease(settings, next, tags)
  }
  if (!current) return withPrerelease(settings, initialVersion, tags)
  const parsed = parseSemver(current)
  if (parsed?.pre && settings.version.prerelease) {
    const core = `${parsed.major}.${parsed.minor}.${parsed.patch}`
    const released = tags.find((tag) => !tag.version.includes('-'))
    const base = released ? bumpSemver(released.version, bump) : initialVersion
    if (compareVersions(base, core) <= 0) return withPrerelease(settings, core, tags)
    return withPrerelease(settings, base, tags)
  }
  return withPrerelease(settings, bumpSemver(current, bump), tags)
}

const tagVersion = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u

interface TagVersion {
  core: [number, number, number]
  pre: string[]
}

function parseTagVersion(name: string): TagVersion | undefined {
  const match = tagVersion.exec(name)
  if (!match) return undefined
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  }
}

/** Whether a tag name is a semantic version, with or without a leading `v`. */
export const isVersion = (name: string) => tagVersion.test(name)

/** Semantic version precedence of two tag names; non-versions compare as equal. */
export function compareVersions(a: string, b: string): number {
  const left = parseTagVersion(a)
  const right = parseTagVersion(b)
  if (!left || !right) return 0
  for (let i = 0; i < 3; i++) {
    const diff = left.core[i]! - right.core[i]!
    if (diff) return diff
  }
  if (!left.pre.length || !right.pre.length) return right.pre.length - left.pre.length
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const numeric = /^\d+$/u
    if (numeric.test(x) && numeric.test(y)) {
      const diff = Number(x) - Number(y)
      if (diff) return diff
    } else if (numeric.test(x) !== numeric.test(y)) {
      return numeric.test(x) ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

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
