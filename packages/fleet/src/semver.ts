/** A parsed `major.minor.patch[-pre]` version; missing parts are `0`. */
export interface Version {
  major: number
  minor: number
  patch: number
  pre?: string
}

/** How far a version is from the latest one. */
export type Lag = 'current' | 'patch' | 'minor' | 'major' | 'ahead' | 'unknown'

const pattern = /v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/

/** Parses the first version found in `text` (`v1.2.3`, `1.2`, `=1.2.3-rc.1`); Go `v` prefixes and `+build` suffixes are accepted. */
export function parseVersion(text: string): Version | undefined {
  const match = pattern.exec(text.trim())
  if (!match) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    ...(match[4] ? { pre: match[4] } : {}),
  }
}

/** Negative when `a` is older than `b`; prereleases sort before their release. */
export function compareVersions(a: Version, b: Version): number {
  const diff = a.major - b.major || a.minor - b.minor || a.patch - b.patch
  if (diff !== 0) return diff
  if (a.pre === b.pre) return 0
  if (a.pre === undefined) return 1
  if (b.pre === undefined) return -1
  return a.pre < b.pre ? -1 : 1
}

/** Compares two version strings; unparsable ones sort first. */
export function compareVersionText(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return left ? 1 : right ? -1 : a.localeCompare(b)
  return compareVersions(left, right)
}

/** `M.m.p[-pre]` without prefixes. */
export const formatVersion = (version: Version) =>
  `${version.major}.${version.minor}.${version.patch}${version.pre ? `-${version.pre}` : ''}`

const nonRegistry = /^(workspace|file|link|portal|git|git\+\w+|github|http|https|catalog):/

/**
 * The lowest version an npm range admits (`^18.2.0` → `18.2.0`, `>=1 <3 || 0.9` → `0.9.0`), or
 * `undefined` for specs that do not name a registry version (`workspace:*`, `latest`, URLs).
 */
export function minimumOfRange(range: string): string | undefined {
  let spec = range.trim()
  if (spec.startsWith('npm:')) spec = spec.slice(spec.lastIndexOf('@') + 1)
  if (nonRegistry.test(spec) || spec.includes('/')) return undefined
  const lows = spec
    .split('||')
    .map((alternative) =>
      parseVersion(
        alternative
          .trim()
          .split(/\s+/)[0]
          ?.replace(/^[\^~>=<]+/, '') ?? '',
      ),
    )
    .filter((version) => version !== undefined)
  const lowest = lows.toSorted(compareVersions)[0]
  return lowest ? formatVersion(lowest) : undefined
}

/** How far `current` is behind `latest`, by the most significant differing part. */
export function lagOf(current: string | undefined, latest: string | undefined): Lag {
  const now = current ? parseVersion(current) : undefined
  const last = latest ? parseVersion(latest) : undefined
  if (!now || !last) return 'unknown'
  const order = compareVersions(now, last)
  if (order === 0) return 'current'
  if (order > 0) return 'ahead'
  if (now.major !== last.major) return 'major'
  if (now.minor !== last.minor) return 'minor'
  return 'patch'
}
