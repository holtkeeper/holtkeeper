import type { EgressCacheEntry, EgressCacheKind } from '@holtkeeper/api'

/** Cache kinds in display order with their labels. */
export const cacheKinds: readonly { id: EgressCacheKind; label: string }[] = [
  { id: 'packages', label: 'Packages' },
  { id: 'tools', label: 'Tools' },
]

export interface CacheTotals {
  count: number
  bytes: number
  hits: number
  /** Bytes served from the cache instead of upstream: every hit saved one download. */
  savedBytes: number
}

/** Count, size, hits and saved bytes of `entries`. */
export const cacheTotals = (entries: readonly EgressCacheEntry[]): CacheTotals =>
  entries.reduce(
    (sum, entry) => ({
      count: sum.count + 1,
      bytes: sum.bytes + entry.size,
      hits: sum.hits + entry.hits,
      savedBytes: sum.savedBytes + entry.hits * entry.size,
    }),
    { count: 0, bytes: 0, hits: 0, savedBytes: 0 },
  )

/** Host of an entry's URL, with its port when it has one. */
export const entryHost = (entry: Pick<EgressCacheEntry, 'url'>): string => {
  try {
    return new URL(entry.url).host
  } catch {
    return entry.url
  }
}

/** The file part of an entry's URL, e.g. `react-19.1.0.tgz`. */
export const entryName = (entry: Pick<EgressCacheEntry, 'url'>): string => {
  try {
    const segments = new URL(entry.url).pathname.split('/').filter(Boolean)
    return decodeURIComponent(segments.at(-1) ?? entry.url)
  } catch {
    return entry.url
  }
}

/** Per host totals, largest first. */
export function hostTotals(
  entries: readonly EgressCacheEntry[],
): ({ host: string } & CacheTotals)[] {
  const byHost = new Map<string, EgressCacheEntry[]>()
  for (const entry of entries) {
    const host = entryHost(entry)
    byHost.set(host, [...(byHost.get(host) ?? []), entry])
  }
  return [...byHost]
    .map(([host, list]) => ({ host, ...cacheTotals(list) }))
    .toSorted((a, b) => b.bytes - a.bytes || a.host.localeCompare(b.host))
}

/** Entries of `kind` (all for `all`) whose URL contains every word of `query`. */
export function filterEntries(
  entries: readonly EgressCacheEntry[],
  kind: EgressCacheKind | 'all',
  query: string,
): EgressCacheEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return entries.filter(
    (entry) =>
      (kind === 'all' || entry.kind === kind) &&
      words.every((word) => entry.url.toLowerCase().includes(word)),
  )
}

/** Share of requests served from the cache, 0..100; `undefined` before any request. */
export const hitRate = (stats: { hits: number; misses: number }): number | undefined =>
  stats.hits + stats.misses > 0 ? (stats.hits / (stats.hits + stats.misses)) * 100 : undefined

/** `4 weeks`, `21 days`, `12 hours`, `90 seconds`: the largest unit that divides `seconds`. */
export function formatTtl(seconds: number): string {
  for (const [unit, size] of [
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ] as const) {
    if (seconds >= size && seconds % size === 0) {
      const count = seconds / size
      return `${count} ${unit}${count === 1 ? '' : 's'}`
    }
  }
  return `${seconds} second${seconds === 1 ? '' : 's'}`
}
