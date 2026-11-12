/** How many of the visible rows are selected, for the header checkbox. */
export type SelectAllState = 'none' | 'some' | 'all'

/** State of the select-all checkbox over `ids`; an empty list reads as `none`. */
export function selectAllState<K>(selected: ReadonlySet<K>, ids: readonly K[]): SelectAllState {
  const count = ids.filter((id) => selected.has(id)).length
  return count === 0 ? 'none' : count === ids.length ? 'all' : 'some'
}

/** Adds or removes every id in `ids`, keeping selected ids outside the list untouched. */
export function selectAll<K>(selected: ReadonlySet<K>, ids: readonly K[], on: boolean): Set<K> {
  const next = new Set(selected)
  for (const id of ids) {
    if (on) next.add(id)
    else next.delete(id)
  }
  return next
}

/** Adds or removes one id. */
export const selectOne = <K>(selected: ReadonlySet<K>, id: K, on: boolean): Set<K> =>
  selectAll(selected, [id], on)
