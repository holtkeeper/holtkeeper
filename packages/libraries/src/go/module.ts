/** Go module proxy path escaping: upper-case letters become `!` + lower case. */
export const escapeModulePath = (path: string) =>
  path.replace(/[A-Z]/g, (char) => `!${char.toLowerCase()}`)

/** Whether `version` is a pseudo-version (`v0.0.0-20240101000000-abcdef123456`). */
export const isPseudoVersion = (version: string) =>
  /[-.]\d{14}-[0-9a-f]{12}(\+incompatible)?$/.test(version)

/** Library name of a module path: the path without its `/vN` major suffix. */
export const libraryOfModule = (path: string) => path.replace(/\/v[2-9]\d*$/, '')

/**
 * Module path that publishes `version` of the library `name`: `name/vN` for majors from 2 up,
 * `name` itself for v0, v1 and `+incompatible` versions. `gopkg.in` paths carry the major in the
 * name and are returned as is.
 */
export function modulePathOf(name: string, version: string) {
  if (name.startsWith('gopkg.in/') || version.endsWith('+incompatible')) return name
  const major = Number(/^v(\d+)\./.exec(version)?.[1] ?? 0)
  return major >= 2 ? `${name}/v${major}` : name
}

const parse = (version: string) => {
  const match = /^v(\d+)\.(\d+)\.(\d+)(?:-([^+]*))?/.exec(version)
  if (!match) return undefined
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4],
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
    const nx = /^\d+$/.test(x) ? Number(x) : undefined
    const ny = /^\d+$/.test(y) ? Number(y) : undefined
    if (nx !== undefined && ny !== undefined) {
      if (nx !== ny) return nx - ny
    } else if (nx !== undefined) return -1
    else if (ny !== undefined) return 1
    else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

const compareSemantic = (a: string, b: string) => {
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return left ? 1 : right ? -1 : a.localeCompare(b)
  for (let i = 0; i < 3; i++) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0)
    if (diff) return diff
  }
  if (left.pre === undefined) return right.pre === undefined ? 0 : 1
  if (right.pre === undefined) return -1
  return comparePre(left.pre, right.pre)
}

/**
 * Semantic version order of Go versions; unparsable versions sort first, versions equal but for
 * build metadata (`+incompatible`) by text.
 */
export const compareGoVersions = (a: string, b: string) =>
  compareSemantic(a, b) || (a < b ? -1 : a > b ? 1 : 0)

/** Whether `version` has no prerelease part. */
export const isStableGoVersion = (version: string) => parse(version)?.pre === undefined
