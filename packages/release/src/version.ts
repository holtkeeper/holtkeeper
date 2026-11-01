import { compareVersions } from '@holtkeeper/changelog'

import type { Bump, ReleaseSettings } from './settings.ts'
import { dateParts } from './template.ts'

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

/** Whether `version` is valid under the settings' scheme. */
export function isValidVersion(settings: ReleaseSettings, version: string): boolean {
  return settings.version.scheme === 'semver'
    ? SEMVER.test(version)
    : calverPattern(settings.version.calver).test(version)
}

const calverKey = (version: string) =>
  version
    .split('-')[0]!
    .split(/\D+/u)
    .filter(Boolean)
    .map((part) => part.padStart(6, '0'))
    .join('.')

/** Orders two versions of the settings' scheme; pre-releases sort before their release. */
export function compareSchemeVersions(settings: ReleaseSettings, a: string, b: string): number {
  if (settings.version.scheme === 'semver') return compareVersions(a, b)
  const order = calverKey(a).localeCompare(calverKey(b))
  if (order !== 0) return order
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

/** The newest released version; pre-releases count only when `prerelease` is set. */
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

function nextCalver(format: string, previous: string | undefined, now: Date, timeZone: string) {
  const parts = dateParts(now, timeZone)
  const values: Record<string, string> = {
    YYYY: parts.year,
    YY: parts.year.slice(2),
    '0M': parts.month,
    MM: String(Number(parts.month)),
    '0D': parts.day,
    DD: String(Number(parts.day)),
  }
  const period = format.replace(/YYYY|YY|0M|MM|0D|DD|MICRO/gu, (token) =>
    token === 'MICRO' ? '\u0000' : (values[token] ?? token),
  )
  const [before = '', after = ''] = period.split('\u0000')
  const base = previous?.split('-')[0]
  if (base?.startsWith(before) && base.endsWith(after)) {
    const micro = base.slice(before.length, base.length - after.length)
    if (/^\d+$/u.test(micro)) return `${before}${Number(micro) + 1}${after}`
  }
  return `${before}0${after}`
}

function withPrerelease(
  settings: ReleaseSettings,
  core: string,
  tags: readonly VersionTag[],
): string {
  const channel = settings.version.prerelease
  if (!channel) return core
  const prefix = `${core}-${channel}.`
  const numbers = tags
    .filter((tag) => tag.version.startsWith(prefix))
    .map((tag) => Number(tag.version.slice(prefix.length)))
    .filter(Number.isInteger)
  return `${prefix}${numbers.length ? Math.max(...numbers) + 1 : 1}`
}

/**
 * The version after `current` for `bump`: semantic versions start at `version.initial`, calendar
 * versions follow the date in the settings' time zone. With a pre-release channel the result is
 * the next pre-release of that version. `undefined` when `bump` is `none`.
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
    return withPrerelease(
      settings,
      nextCalver(settings.version.calver, released, now, settings.timezone),
      tags,
    )
  }
  if (!current) return withPrerelease(settings, settings.version.initial, tags)
  const parsed = parseSemver(current)
  if (parsed?.pre && settings.version.prerelease) {
    const core = `${parsed.major}.${parsed.minor}.${parsed.patch}`
    const released = tags.find((tag) => !tag.version.includes('-'))
    const base = released ? bumpSemver(released.version, bump) : settings.version.initial
    if (compareVersions(base, core) <= 0) return withPrerelease(settings, core, tags)
    return withPrerelease(settings, base, tags)
  }
  return withPrerelease(settings, bumpSemver(current, bump), tags)
}
