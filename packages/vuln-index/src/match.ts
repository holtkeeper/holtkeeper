import type { KvStore } from '@holtkeeper/store'
import { type OsvClient, type OsvRecord, osvRecordSchema } from '@holtkeeper/vuln-osv'
import { z } from 'zod'

/** A package version as the index looks it up. */
export interface IndexedPackage {
  ecosystem: string
  name: string
  version: string
}

/** The key of a package version in `MatchResult.records`. */
export const packageKey = (pkg: IndexedPackage) => `${pkg.ecosystem}\0${pkg.name}\0${pkg.version}`

/** OSV records kept between runs, so only advisories whose `modified` changed are fetched again. */
export interface VulnRecordCache {
  get(id: string): Promise<{ modified: string; record: OsvRecord } | undefined>
  set(id: string, entry: { modified: string; record: OsvRecord }): Promise<void>
}

const cachedSchema = z.object({ modified: z.string(), record: osvRecordSchema })

const cacheKey = (id: string) => `vuln-index:osv:${id}`

/**
 * A `VulnRecordCache` in a `KvStore`, one key per advisory (`vuln-index:osv:<id>`). Entries expire
 * after `ttlSeconds` (default 30 days) and are fetched again then; unreadable entries count as
 * missing.
 */
export function kvRecordCache(
  kv: Pick<KvStore, 'get' | 'set'>,
  options: { ttlSeconds?: number } = {},
): VulnRecordCache {
  const ttl = options.ttlSeconds ?? 30 * 86_400
  return {
    async get(id) {
      return cachedSchema.safeParse(await kv.get(cacheKey(id))).data
    },
    async set(id, entry) {
      await kv.set(cacheKey(id), entry, ttl)
    },
  }
}

/** What `matchPackages` found. */
export interface MatchResult {
  /** The advisories affecting each package version, by `packageKey`; unaffected ones are absent. */
  records: Map<string, OsvRecord[]>
  /** Distinct package versions queried. */
  queried: number
  /** Advisory records fetched because they were new or changed. */
  fetched: number
}

/** Options of `matchPackages`. */
export interface MatchOptions {
  client: OsvClient
  cache: VulnRecordCache
  packages: Iterable<IndexedPackage>
  /** Advisory records fetched at once. Default 8. */
  concurrency?: number
  signal?: AbortSignal
}

async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
) {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      // oxlint-disable-next-line no-await-in-loop -- a fixed number of workers share the list
      if (item !== undefined) await task(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/**
 * The OSV advisories affecting each distinct package version: one batched lookup for all of them,
 * then the full record of every advisory found, from `cache` while its `modified` time is current.
 * Advisories OSV no longer knows are left out. Throws when OSV fails, so a failed lookup never
 * reads as "not affected".
 */
export async function matchPackages(options: MatchOptions): Promise<MatchResult> {
  const unique = new Map<string, IndexedPackage>()
  for (const pkg of options.packages) unique.set(packageKey(pkg), pkg)
  const queries = [...unique.values()]
  const refs = await options.client.queryBatch(queries, {
    ...(options.signal && { signal: options.signal }),
  })

  const modified = new Map<string, string>()
  for (const list of refs)
    for (const ref of list) {
      const known = modified.get(ref.id)
      if (known === undefined || ref.modified > known) modified.set(ref.id, ref.modified)
    }

  const records = new Map<string, OsvRecord>()
  let fetched = 0
  await eachLimited([...modified], options.concurrency ?? 8, async ([id, changed]) => {
    const cached = await options.cache.get(id)
    if (cached?.modified === changed) {
      records.set(id, cached.record)
      return
    }
    const record = await options.client.vulnerability(id, {
      ...(options.signal && { signal: options.signal }),
    })
    fetched += 1
    if (!record) return
    records.set(id, record)
    await options.cache.set(id, { modified: changed, record })
  })

  const byPackage = new Map<string, OsvRecord[]>()
  for (const [index, list] of refs.entries()) {
    const pkg = queries[index]
    if (!pkg) continue
    const found = [...new Set(list.map((ref) => ref.id))].flatMap((id) => {
      const record = records.get(id)
      return record ? [record] : []
    })
    if (found.length) byPackage.set(packageKey(pkg), found)
  }
  return { records: byPackage, queried: queries.length, fetched }
}
