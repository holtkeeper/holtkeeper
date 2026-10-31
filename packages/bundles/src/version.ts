const pattern = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function comparePre(a: string[], b: string[]): number {
  if (!a.length || !b.length) return Number(!a.length) - Number(!b.length)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index]
    const right = b[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const numeric = /^\d+$/.test(left) && /^\d+$/.test(right)
    const diff = numeric ? Number(left) - Number(right) : left.localeCompare(right)
    if (diff) return diff
  }
  return 0
}

/**
 * Semantic version order, negative when `a` is older. Prereleases sort before their release;
 * versions that do not parse sort first, among themselves by text.
 */
export function compareVersions(a: string, b: string): number {
  const left = pattern.exec(a.trim())
  const right = pattern.exec(b.trim())
  if (!left || !right) return left ? 1 : right ? -1 : a.localeCompare(b)
  for (const index of [1, 2, 3]) {
    const diff = Number(left[index] ?? 0) - Number(right[index] ?? 0)
    if (diff) return diff
  }
  return comparePre(left[4]?.split('.') ?? [], right[4]?.split('.') ?? [])
}
