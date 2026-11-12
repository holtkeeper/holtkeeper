import type { KvStore, LibraryRef } from '@holtkeeper/store'

import { parseSemver } from './semver.ts'

/** The newest stable release of a library as its registry last reported it. */
export interface LatestVersion {
  latest: string
  checkedAt: string
}

/**
 * The one place that knows the newest published version of every third-party library in use, by
 * `<ecosystem>:<name>` (Go libraries by module path without the `/vN` suffix). Written by library
 * index runs from the registry answers they fetch anyway; read by Supply › Libraries and agents.
 */
export interface LatestVersions {
  get(ref: LibraryRef): Promise<LatestVersion | undefined>
  /** Every known entry, by `<ecosystem>:<name>`. */
  all(): Promise<Map<string, LatestVersion>>
  /**
   * Stores `entries` over the known ones; with `keep`, entries whose key is not in it are dropped
   * (libraries nothing uses any more).
   */
  record(
    entries: readonly (LibraryRef & LatestVersion)[],
    keep?: ReadonlySet<string>,
  ): Promise<void>
}

const KEY = 'libraries:latest'
const ATTEMPTS = 5

const keyOf = (ref: LibraryRef) => `${ref.ecosystem}:${ref.name}`

const entriesOf = (value: unknown): Record<string, LatestVersion> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result: Record<string, LatestVersion> = {}
  for (const [key, entry] of Object.entries(value))
    if (
      typeof entry === 'object' &&
      entry !== null &&
      'latest' in entry &&
      typeof entry.latest === 'string' &&
      'checkedAt' in entry &&
      typeof entry.checkedAt === 'string'
    )
      result[key] = { latest: entry.latest, checkedAt: entry.checkedAt }
  return result
}

/** `LatestVersions` kept as one document in `kv`; writes are atomic where `kv` has `compareAndSet`. */
export function latestVersions(kv: Pick<KvStore, 'get' | 'set' | 'compareAndSet'>): LatestVersions {
  const read = async () => entriesOf(await kv.get(KEY))
  return {
    async get(ref) {
      return (await read())[keyOf(ref)]
    },
    async all() {
      return new Map(Object.entries(await read()))
    },
    async record(entries, keep) {
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        // oxlint-disable-next-line no-await-in-loop -- retried only when another writer won
        const before = await kv.get(KEY)
        const next = entriesOf(before)
        for (const entry of entries)
          next[keyOf(entry)] = { latest: entry.latest, checkedAt: entry.checkedAt }
        if (keep) for (const key of Object.keys(next)) if (!keep.has(key)) delete next[key]
        if (!kv.compareAndSet) return kv.set(KEY, next)
        // oxlint-disable-next-line no-await-in-loop
        if (await kv.compareAndSet(KEY, before, next)) return
      }
      throw new Error('latest versions changed under every attempt to store them')
    },
  }
}

/**
 * How many breaking releases `version` is behind `latest`: majors apart, and below 1.0 one per
 * minor (which semver treats as breaking). 0 when it is not older or a version does not parse.
 */
export function majorsBehind(version: string, latest: string): number {
  const used = parseSemver(version)
  const newest = parseSemver(latest)
  if (!used || !newest) return 0
  if (newest.major > used.major) return newest.major - used.major
  if (newest.major === 0 && used.major === 0 && newest.minor > used.minor)
    return newest.minor - used.minor
  return 0
}
