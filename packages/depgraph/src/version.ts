const parts = (version: string) => {
  const [core = '', ...rest] = version.replace(/^v/, '').split(/[-+]/)
  return {
    numbers: core.split('.').map((part) => Number.parseInt(part, 10) || 0),
    pre: rest.join('-'),
  }
}

/**
 * Orders versions the semver way (`v` prefix allowed, prereleases before releases). Unknown
 * formats fall back to string order, so sorting never throws.
 */
export function compareVersions(a: string, b: string): number {
  const left = parts(a)
  const right = parts(b)
  for (let i = 0; i < Math.max(left.numbers.length, right.numbers.length); i++) {
    const diff = (left.numbers[i] ?? 0) - (right.numbers[i] ?? 0)
    if (diff !== 0) return diff
  }
  if (left.pre !== right.pre) {
    if (!left.pre) return 1
    if (!right.pre) return -1
    return left.pre.localeCompare(right.pre, 'en', { numeric: true })
  }
  return a.localeCompare(b)
}
