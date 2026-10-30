import type { ChangeItem, Conflict } from '@holtkeeper/api'

/** Adds or removes one change id. */
export function toggle(selection: ReadonlySet<string>, id: string, on: boolean): Set<string> {
  const next = new Set(selection)
  if (on) next.add(id)
  else next.delete(id)
  return next
}

/** Ids of changes marked `safe`, skipping those with known conflicts. */
export function safeIds(
  items: readonly ChangeItem[],
  conflicts: ReadonlyMap<string, readonly Conflict[]> = new Map(),
): string[] {
  return items
    .filter((item) => item.change.confidence === 'safe' && !conflicts.has(item.change.id))
    .map((item) => item.change.id)
}

/** Adds every safe change to the selection. */
export const selectAllSafe = (
  selection: ReadonlySet<string>,
  items: readonly ChangeItem[],
  conflicts?: ReadonlyMap<string, readonly Conflict[]>,
): Set<string> => new Set([...selection, ...safeIds(items, conflicts)])

/** Keeps only ids that still exist among the items, in item order. */
export const selectedIds = (
  selection: ReadonlySet<string>,
  items: readonly ChangeItem[],
): string[] => items.map((item) => item.change.id).filter((id) => selection.has(id))

/** Conflicts grouped by change id. */
export function conflictsByChange(conflicts: readonly Conflict[]): Map<string, Conflict[]> {
  const map = new Map<string, Conflict[]>()
  for (const conflict of conflicts)
    map.set(conflict.changeId, [...(map.get(conflict.changeId) ?? []), conflict])
  return map
}

/** Default merge request title for the selected changes. */
export function mergeRequestTitle(items: readonly ChangeItem[], ids: readonly string[]): string {
  const chosen = items.filter((item) => ids.includes(item.change.id))
  if (chosen.length === 1) return chosen[0]!.change.title
  const sources = [...new Set(chosen.map((item) => item.change.source))]
  return `Apply ${chosen.length} suggested changes${sources.length === 1 ? ` from ${sources[0]}` : ''}`
}
