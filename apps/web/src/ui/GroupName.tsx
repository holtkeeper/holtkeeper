import { useGroupTitles } from '../api/queries.ts'

/** A group as people read it: its display title, or its key when it has none. */
export function GroupName({ group }: { group: string }) {
  return useGroupTitles()(group)
}
