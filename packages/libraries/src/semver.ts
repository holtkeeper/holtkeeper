/** A parsed semantic version; `pre` holds the dot-separated prerelease identifiers. */
export interface SemVer {
  major: number
  minor: number
  patch: number
  pre: string[]
}

const pattern =
  /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Parses `1.2.3`, `v1.2.3` (Go), `1.2.3-rc.1`, `v2.0.0+incompatible`; missing minor and patch are
 * `0`. `undefined` for anything else, including Go pseudo-versions' invalid forms.
 */
export function parseSemver(text: string): SemVer | undefined {
  const match = pattern.exec(text.trim())
  if (!match) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    pre: match[4] ? match[4].split('.') : [],
  }
}

const comparePre = (a: string[], b: string[]): number => {
  if (!a.length || !b.length) return Number(!a.length) - Number(!b.length)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i]
    const right = b[i]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumber = /^\d+$/.test(left)
    const rightNumber = /^\d+$/.test(right)
    if (leftNumber && rightNumber) {
      const diff = Number(left) - Number(right)
      if (diff) return diff
    } else if (leftNumber !== rightNumber) return leftNumber ? -1 : 1
    else if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

/** Semantic version order of parsed versions; build metadata is ignored. */
export const compareParsed = (a: SemVer, b: SemVer): number =>
  a.major - b.major || a.minor - b.minor || a.patch - b.patch || comparePre(a.pre, b.pre)

/** Negative when `a` is older than `b`. Unparsable versions sort first, among themselves by text. */
export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (!left || !right) return left ? 1 : right ? -1 : a.localeCompare(b)
  return compareParsed(left, right)
}

/** Whether `version` parses and has prerelease identifiers. */
export const isPrerelease = (version: string) => (parseSemver(version)?.pre.length ?? 0) > 0

/** The major of `version`, or `undefined` when it does not parse. */
export const majorOf = (version: string) => parseSemver(version)?.major

/** Whether `version` lies in `(from, to]`; either bound may be missing. */
export function inRange(version: string, from?: string, to?: string): boolean {
  if (!parseSemver(version)) return false
  if (from !== undefined && compareSemver(version, from) <= 0) return false
  if (to !== undefined && compareSemver(version, to) > 0) return false
  return true
}

/** Whether two version strings name the same version (`v1.2.3` and `1.2.3` do). */
export const sameVersion = (a: string, b: string) =>
  a === b || (parseSemver(a) !== undefined && compareSemver(a, b) === 0)
