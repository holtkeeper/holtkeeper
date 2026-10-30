import type { ArtifactStore } from './types.ts'

/** One line of a storage breakdown, e.g. a content type or a repository. */
export interface StorageDetail {
  label: string
  bytes: number
  count?: number
}

/** How much a storage area uses. `available: false` means it is not used in this setup. */
export interface StorageUsage {
  bytes: number
  count?: number
  details?: StorageDetail[]
  available?: boolean
  /** Why it is unavailable, or how the size was measured. */
  note?: string
}

/** What `clear` removed; fields are absent when the provider cannot tell. */
export interface StorageClearResult {
  removed?: number
  bytes?: number
}

/**
 * A place Holtkeeper keeps data on disk or in a bucket (artifacts, git mirrors, tool caches, the
 * database), shown in the storage overview. `clear` is absent when the data cannot be dropped;
 * `scope` narrows it to what the provider documents (a tag, a repository, an age).
 */
export interface StorageProvider {
  id: string
  label: string
  usage(): Promise<StorageUsage>
  clear?(scope?: string): Promise<StorageClearResult>
}

const sortedDetails = (entries: [string, { count: number; bytes: number }][], prefix = '') =>
  entries
    .map(([label, { count, bytes }]) => ({ label: `${prefix}${label}`, bytes, count }))
    .toSorted((a, b) => b.bytes - a.bytes || a.label.localeCompare(b.label))

/**
 * The artifact store as a storage provider: details by content type, then by `repo` tag.
 * `clear()` removes every artifact; `clear('repo=work:games/a')` only those with that tag value;
 * `clear('olderThanDays=30')` those not accessed for 30 days.
 */
export function artifactStorage(store: ArtifactStore, label = 'Artifacts'): StorageProvider {
  return {
    id: 'artifacts',
    label,
    async usage() {
      const usage = await store.usage()
      return {
        bytes: usage.bytes,
        count: usage.count,
        details: [
          ...sortedDetails(Object.entries(usage.byContentType)),
          ...sortedDetails(Object.entries(usage.byTag.repo ?? {}), 'repo '),
        ],
      }
    },
    async clear(scope) {
      const separator = scope?.indexOf('=') ?? -1
      const key = scope && separator > 0 ? scope.slice(0, separator) : undefined
      const value = scope && separator > 0 ? scope.slice(separator + 1) : undefined
      if (scope && !key)
        throw new Error(`unknown scope ${scope}; use <tag>=<value> or olderThanDays=<n>`)
      if (key === 'olderThanDays') {
        const days = Number(value)
        if (!Number.isFinite(days) || days < 0) throw new Error(`invalid number of days: ${value}`)
        return store.sweep({ olderThan: new Date(Date.now() - days * 86_400_000) })
      }
      const result = { removed: 0, bytes: 0 }
      let cursor: string | undefined
      const doomed: { id: string; bytes: number }[] = []
      do {
        const page = await store.list({ limit: 1000, ...(cursor ? { cursor } : {}) })
        for (const item of page.items) {
          if (!key || item.tags?.[key] === value) doomed.push(item)
        }
        cursor = page.cursor
      } while (cursor)
      for (const item of doomed) {
        if (await store.delete(item.id)) {
          result.removed += 1
          result.bytes += item.bytes
        }
      }
      return result
    },
  }
}
