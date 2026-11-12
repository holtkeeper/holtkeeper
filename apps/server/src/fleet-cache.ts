const DEFAULT_MAX_ENTRIES = 200

const setOf = (values: Iterable<string>) => [...new Set(values)].toSorted().join('\n')

/**
 * Remembers the response of a fleet endpoint while the records it read stay the newest. An entry
 * answers again only for the same endpoint, the same set of latest analysis ids and the same set of
 * repositories the caller may see; each endpoint and visibility keeps only its newest entry, and the
 * whole cache holds at most `maxEntries`, dropping the least recently used. A failed load is not
 * kept, and concurrent reads of the same key share one load.
 */
export interface FleetCache {
  read<T>(
    key: {
      /** The endpoint and every parameter that changes its answer, e.g. `licenses?group=web`. */
      endpoint: string
      /** Ids of the latest records the answer is computed from; order does not matter. */
      analysisIds: Iterable<string>
      /** Repositories the caller may see, as `forge:path`; order does not matter. */
      repos: Iterable<string>
    },
    load: () => Promise<T>,
  ): Promise<T>
}

/** A fresh, empty `FleetCache` holding at most `maxEntries` entries (200 by default). */
export function createFleetCache(options: { maxEntries?: number } = {}): FleetCache {
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES)
  const entries = new Map<string, { records: string; value: Promise<unknown> }>()

  return {
    read<T>(
      key: { endpoint: string; analysisIds: Iterable<string>; repos: Iterable<string> },
      load: () => Promise<T>,
    ): Promise<T> {
      const slot = `${key.endpoint}\0${setOf(key.repos)}`
      const records = setOf(key.analysisIds)
      const hit = entries.get(slot)
      entries.delete(slot)
      if (hit?.records === records) {
        entries.set(slot, hit)
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- one slot always holds the same endpoint's type
        return hit.value as Promise<T>
      }
      const value = (async () => load())()
      const entry = { records, value }
      entries.set(slot, entry)
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
      value.catch(() => {
        if (entries.get(slot) === entry) entries.delete(slot)
      })
      return value
    },
  }
}
