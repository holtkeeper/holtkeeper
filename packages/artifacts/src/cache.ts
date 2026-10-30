import { createHash } from 'node:crypto'

import { isRefName } from './core.ts'
import type { ArtifactStore, RefMeta } from './types.ts'

/** What `BlobCache.set` stores besides the bytes. */
export interface CacheEntryOptions {
  meta?: RefMeta
  contentType?: string
  /** Suggested file name of the content. */
  name?: string
}

/**
 * Bytes kept between runs under keys the caller derives from its inputs. Entries may disappear at
 * any time (sweeps, deletes), so a miss is normal. Neither method throws: a broken backend reads
 * as a miss and loses writes.
 */
export interface BlobCache {
  get(key: string): Promise<{ data: Uint8Array; meta: RefMeta } | undefined>
  set(key: string, data: Uint8Array, entry?: CacheEntryOptions): Promise<void>
}

export interface ArtifactCacheOptions {
  /** First segment of every ref, e.g. `cache`. Default `cache`. */
  namespace?: string
  /** Tags of every stored artifact, e.g. `{ kind: 'cache' }`. Default `{ kind: 'cache' }`. */
  tags?: Record<string, string>
  /** Called with errors the cache swallows. */
  onError?: (error: unknown) => void
}

/**
 * A `BlobCache` on an artifact store: content goes in as artifacts (deduplicated by hash, swept
 * like any other), the key becomes the ref `<namespace>/<key>`. Keys that are not valid ref names
 * are hashed. On S3 this keeps expensive results (encoded image variants, optimized SVGs) across
 * processes and machines.
 */
export function artifactCache(store: ArtifactStore, options: ArtifactCacheOptions = {}): BlobCache {
  const namespace = options.namespace ?? 'cache'
  const tags = options.tags ?? { kind: 'cache' }
  const refOf = (key: string) => {
    const name = `${namespace}/${key}`
    return isRefName(name)
      ? name
      : `${namespace}/sha256-${createHash('sha256').update(key).digest('hex')}`
  }
  const swallow = (error: unknown) => {
    options.onError?.(error)
    return undefined
  }
  return {
    async get(key) {
      try {
        const ref = await store.getRef(refOf(key))
        if (!ref) return undefined
        const artifact = await store.get(ref.id)
        return artifact ? { data: artifact.data, meta: ref.meta ?? {} } : undefined
      } catch (error) {
        return swallow(error)
      }
    },
    async set(key, data, entry = {}) {
      try {
        const { id } = await store.put(data, {
          ...(entry.contentType ? { contentType: entry.contentType } : {}),
          ...(entry.name ? { name: entry.name } : {}),
          tags,
        })
        await store.setRef(refOf(key), { id, ...(entry.meta ? { meta: entry.meta } : {}) })
      } catch (error) {
        swallow(error)
      }
    },
  }
}
