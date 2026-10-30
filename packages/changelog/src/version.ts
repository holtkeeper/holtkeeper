const pattern = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u

interface Version {
  core: [number, number, number]
  pre: string[]
}

function parse(name: string): Version | undefined {
  const match = pattern.exec(name)
  if (!match) return undefined
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  }
}

/** Whether a tag name is a semantic version, with or without a leading `v`. */
export const isVersion = (name: string) => pattern.test(name)

/** Semantic version precedence of two tag names; non-versions compare as equal. */
export function compareVersions(a: string, b: string): number {
  const left = parse(a)
  const right = parse(b)
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
