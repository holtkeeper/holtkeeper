/** A parsed `major.minor.patch[-pre]` version; missing parts are `0`. */
export interface Version {
  major: number
  minor: number
  patch: number
  pre?: string
}

const pattern = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** Parses `1.2.3`, `v1.2`, `1.2.3-rc.1`; `undefined` for anything else. */
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

const comparePre = (a: string, b: string) => {
  const left = a.split('.')
  const right = b.split('.')
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i]
    const y = right[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const numeric = /^\d+$/
    if (numeric.test(x) && numeric.test(y)) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y)
    } else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** Negative when `a` is older than `b`; prereleases sort before their release. */
export function compareVersions(a: Version, b: Version): number {
  const diff = a.major - b.major || a.minor - b.minor || a.patch - b.patch
  if (diff !== 0) return diff
  if (a.pre === b.pre) return 0
  if (a.pre === undefined) return 1
  if (b.pre === undefined) return -1
  return comparePre(a.pre, b.pre)
}

/** Compares version strings; `undefined` when either does not parse. */
export function compareVersionText(a: string, b: string): number | undefined {
  const left = parseVersion(a)
  const right = parseVersion(b)
  return left && right ? compareVersions(left, right) : undefined
}

/** `1.2.3`, with `-pre` when present. */
export const formatVersion = (version: Version) =>
  `${version.major}.${version.minor}.${version.patch}${version.pre ? `-${version.pre}` : ''}`

const protocol = /^[a-z][a-z+-]*:/i

/**
 * The lowest version an npm range admits (`^18.2.0` → `18.2.0`, `>=1 <3 || 0.9` → `0.9.0`), or
 * `undefined` for specs that name no registry version (`workspace:*`, `catalog:`, tags, URLs).
 */
export function minimumOfRange(range: string): string | undefined {
  const spec = range.trim()
  if (protocol.test(spec) || spec.includes('/') || spec === '' || spec === '*') return undefined
  const lows = spec
    .split('||')
    .map((alternative) =>
      parseVersion(
        (alternative.trim().split(/\s+/)[0] ?? '')
          .replace(/^[\^~>=<]+/, '')
          .replace(/\.[x*]/gi, ''),
      ),
    )
    .filter((version) => version !== undefined)
  const lowest = lows.toSorted(compareVersions)[0]
  return lowest ? formatVersion(lowest) : undefined
}

/**
 * The declaration that moves `declared` to `target` in the same style: `^1.2.3` → `^2.0.0`,
 * `~1.2` → `~2.0.0`, exact stays exact, `>=1.2.3` → `>=2.0.0`; compound ranges become `^target`.
 * `undefined` when `declared` names no registry version (protocols, tags, `*`).
 */
export function bumpRange(declared: string, target: string): string | undefined {
  const spec = declared.trim()
  if (minimumOfRange(spec) === undefined) return undefined
  const version = target.replace(/^v/, '')
  const simple = /^(\^|~|>=|=)?v?\d+(?:\.\d+){0,2}(?:-[\w.-]+)?$/.exec(spec)
  if (simple) return `${simple[1] ?? ''}${version}`
  return `^${version}`
}

/** Whether `declared` already starts at or above `target`, so bumping would not raise it. */
export function isAtLeast(declared: string, target: string): boolean {
  const low = minimumOfRange(declared)
  if (low === undefined) return false
  return (compareVersionText(low, target) ?? -1) >= 0
}

/** Turns a glob into an anchored regular expression; `*` stays within a segment, `**` crosses them. */
export function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!
    if (char === '*' && glob[i + 1] === '*') {
      source += '.*'
      i++
      if (glob[i + 1] === '/') {
        source = `${source.slice(0, -2)}(?:.*/)?`
        i++
      }
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}
