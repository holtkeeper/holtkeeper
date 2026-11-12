import { useGroupTitles } from '../api/queries.ts'
import { groupPathTitle } from '../lib/group-titles.ts'

/**
 * A group as people read it: its display title, or its key when it has none. With `path`, a
 * subgroup carries its parent's title in front (`Shapes › Round`).
 */
export function GroupName({ group, path = false }: { group: string; path?: boolean }) {
  const titleOf = useGroupTitles()
  return path ? groupPathTitle(titleOf, group) : titleOf(group)
}
