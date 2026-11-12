/**
 * Format of a group key: a root group (`shapes`) or a subgroup of one (`shapes.round`). A
 * subgroup's parent is the part before the dot; there is at most one level of nesting.
 */
export const GROUP_KEY_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)?$/

/** The group `key` is a subgroup of, or `undefined` for a root group. */
export function parentGroup(key: string): string | undefined {
  const dot = key.lastIndexOf('.')
  return dot > 0 ? key.slice(0, dot) : undefined
}

/** The root group of `key`: `key` itself for a root group. */
export const rootGroup = (key: string): string => key.split('.', 1)[0] ?? key

/** Whether `key` names a subgroup. */
export const isSubgroup = (key: string): boolean => parentGroup(key) !== undefined

/** `key` and every group it belongs to, deepest first: `['shapes.round', 'shapes']`. */
export function groupLineage(key: string): string[] {
  const lineage = [key]
  for (let parent = parentGroup(key); parent !== undefined; parent = parentGroup(parent)) {
    lineage.push(parent)
  }
  return lineage
}

/** `groups` without any group that also has a descendant in the list, in their original order. */
export function leafGroups(groups: readonly string[]): string[] {
  const ancestors = new Set(groups.flatMap((key) => groupLineage(key).slice(1)))
  return [...new Set(groups)].filter((key) => !ancestors.has(key))
}

/**
 * `groups` without any group whose ancestor is also in the list, in their original order. For
 * OR-ed scope entries, where a parent already covers its subgroups.
 */
export function outerGroups(groups: readonly string[]): string[] {
  const listed = new Set(groups)
  return [...listed].filter(
    (key) =>
      !groupLineage(key)
        .slice(1)
        .some((up) => listed.has(up)),
  )
}
