import { createHash } from 'node:crypto'

import type {
  Artifact,
  ArtifactInfo,
  ArtifactPage,
  ArtifactRef,
  ArtifactStore,
  ArtifactUsage,
  PresignOptions,
  SweepResult,
} from './types.ts'

/** Lowercase hex SHA-256 of `data`: the id an artifact store gives this content. */
export const artifactId = (data: Uint8Array): string =>
  createHash('sha256').update(data).digest('hex')

/** Whether `id` looks like an artifact id (64 lowercase hex characters). */
export const isArtifactId = (id: string): boolean => /^[0-9a-f]{64}$/.test(id)

/** Whether `name` can name a ref: `/`-separated segments of `[A-Za-z0-9._:-]`, no `.`/`..` segments. */
export const isRefName = (name: string): boolean =>
  name.length > 0 &&
  name.length <= 512 &&
  name
    .split('/')
    .every((segment) => /^[A-Za-z0-9._:-]+$/.test(segment) && segment !== '.' && segment !== '..')

/** Whether `value` has the shape of `ArtifactRef`, e.g. a parsed ref file. */
export function isArtifactRef(value: unknown): value is ArtifactRef {
  if (typeof value !== 'object' || value === null) return false
  const ref: Partial<Record<keyof ArtifactRef, unknown>> = value
  return (
    typeof ref.id === 'string' &&
    isArtifactId(ref.id) &&
    typeof ref.updatedAt === 'string' &&
    (ref.meta === undefined || (typeof ref.meta === 'object' && ref.meta !== null))
  )
}

/** `ab/cd/<id>`: the two-level fan-out path stores use below their root. */
export const fanout = (id: string): string => `${id.slice(0, 2)}/${id.slice(2, 4)}/${id}`

/** Whether `value` has the shape of `ArtifactInfo`, e.g. a parsed metadata sidecar. */
export function isArtifactInfo(value: unknown): value is ArtifactInfo {
  if (typeof value !== 'object' || value === null) return false
  const info: Partial<Record<keyof ArtifactInfo, unknown>> = value
  return (
    typeof info.id === 'string' &&
    typeof info.bytes === 'number' &&
    typeof info.contentType === 'string' &&
    typeof info.createdAt === 'string'
  )
}

/** Storage primitives a backend provides; `createArtifactStore` builds the store logic on top. */
export interface ArtifactBackend {
  readMeta(id: string): Promise<ArtifactInfo | undefined>
  /** Written after the data, so a present sidecar means the artifact is complete. */
  writeMeta(info: ArtifactInfo): Promise<void>
  writeData(id: string, data: Uint8Array, contentType: string): Promise<void>
  readData(id: string): Promise<Uint8Array | undefined>
  streamData(id: string): Promise<ReadableStream<Uint8Array> | undefined>
  /** Removes data and metadata; missing parts are fine. */
  remove(id: string): Promise<void>
  /** Metadata of every stored artifact, in any order. */
  listMeta(): Promise<ArtifactInfo[]>
  presign?(info: ArtifactInfo, options: PresignOptions): string
  readRef(name: string): Promise<ArtifactRef | undefined>
  writeRef(name: string, ref: ArtifactRef): Promise<void>
  /** Missing refs are fine. */
  removeRef(name: string): Promise<void>
}

export interface StoreOptions {
  /** Default `() => new Date()`. */
  now?: () => Date
  /** Access times are rewritten at most this often per artifact. Default one hour. */
  touchIntervalMs?: number
  /** `usage()` is computed at most this often; `0` always recomputes. Default 0. */
  usageCacheMs?: number
}

const emptyUsage = (): ArtifactUsage => ({ count: 0, bytes: 0, byContentType: {}, byTag: {} })

const add = (bucket: { count: number; bytes: number }, bytes: number) => {
  bucket.count += 1
  bucket.bytes += bytes
}

/** Totals of a list of artifacts, as `ArtifactStore.usage` reports them. */
export function summarizeUsage(items: readonly ArtifactInfo[]): ArtifactUsage {
  const usage = emptyUsage()
  for (const item of items) {
    add(usage, item.bytes)
    add((usage.byContentType[item.contentType] ??= { count: 0, bytes: 0 }), item.bytes)
    for (const [key, value] of Object.entries(item.tags ?? {})) {
      const values = (usage.byTag[key] ??= {})
      add((values[value] ??= { count: 0, bytes: 0 }), item.bytes)
    }
  }
  return usage
}

const lastAccess = (info: ArtifactInfo) => Date.parse(info.lastAccessedAt ?? info.createdAt)

/** Builds an `ArtifactStore` on a backend; the in-repo stores are all made this way. */
export function createArtifactStore(
  backend: ArtifactBackend,
  options: StoreOptions = {},
): ArtifactStore {
  const now = options.now ?? (() => new Date())
  const touchInterval = options.touchIntervalMs ?? 3_600_000
  const usageCacheMs = options.usageCacheMs ?? 0
  let cachedUsage: { at: number; usage: ArtifactUsage } | undefined

  const stat = async (id: string) => (isArtifactId(id) ? backend.readMeta(id) : undefined)
  const touch = async (info: ArtifactInfo): Promise<ArtifactInfo> => {
    const at = now()
    if (at.getTime() - lastAccess(info) < touchInterval) return info
    const touched = { ...info, lastAccessedAt: at.toISOString() }
    await backend.writeMeta(touched)
    return touched
  }
  const remove = async (id: string) => {
    await backend.remove(id)
    cachedUsage = undefined
  }

  return {
    async put(data, put = {}) {
      const id = artifactId(data)
      const at = now().toISOString()
      const existing = await backend.readMeta(id)
      const contentType = put.contentType ?? existing?.contentType ?? 'application/octet-stream'
      const name = put.name ?? existing?.name
      const tags = existing?.tags || put.tags ? { ...existing?.tags, ...put.tags } : undefined
      if (!existing) await backend.writeData(id, data, contentType)
      await backend.writeMeta({
        id,
        bytes: data.byteLength,
        contentType,
        ...(name ? { name } : {}),
        createdAt: existing?.createdAt ?? at,
        lastAccessedAt: at,
        ...(tags ? { tags } : {}),
      })
      cachedUsage = undefined
      return { id, bytes: data.byteLength }
    },

    async get(id) {
      const info = await stat(id)
      if (!info) return undefined
      const data = await backend.readData(id)
      if (!data) return undefined
      return { ...(await touch(info)), data } satisfies Artifact
    },

    async open(id) {
      const info = await stat(id)
      if (!info) return undefined
      const body = await backend.streamData(id)
      if (!body) return undefined
      return { info: await touch(info), body }
    },

    stat,

    async has(id) {
      return (await stat(id)) !== undefined
    },

    async delete(id) {
      if (!(await stat(id))) return false
      await remove(id)
      return true
    },

    async list({ prefix = '', cursor, limit = 100 } = {}): Promise<ArtifactPage> {
      const size = Math.min(Math.max(limit, 1), 1000)
      const matching = (await backend.listMeta())
        .filter((info) => info.id.startsWith(prefix) && (!cursor || info.id > cursor))
        .toSorted((a, b) => (a.id < b.id ? -1 : 1))
      const items = matching.slice(0, size)
      const last = items.at(-1)
      return matching.length > size && last ? { items, cursor: last.id } : { items }
    },

    async usage() {
      const at = Date.now()
      if (cachedUsage && at - cachedUsage.at < usageCacheMs) return cachedUsage.usage
      const usage = summarizeUsage(await backend.listMeta())
      if (usageCacheMs > 0) cachedUsage = { at, usage }
      return usage
    },

    async sweep({ olderThan, maxBytes }): Promise<SweepResult> {
      const result: SweepResult = { removed: 0, bytes: 0 }
      if (!olderThan && maxBytes === undefined) return result
      let items = (await backend.listMeta()).toSorted((a, b) => lastAccess(a) - lastAccess(b))
      const drop = async (info: ArtifactInfo) => {
        await remove(info.id)
        result.removed += 1
        result.bytes += info.bytes
      }
      if (olderThan) {
        const cutoff = olderThan.getTime()
        for (const info of items.filter((item) => lastAccess(item) < cutoff)) await drop(info)
        items = items.filter((item) => lastAccess(item) >= cutoff)
      }
      if (maxBytes !== undefined) {
        let total = items.reduce((sum, item) => sum + item.bytes, 0)
        for (const info of items) {
          if (total <= maxBytes) break
          await drop(info)
          total -= info.bytes
        }
      }
      return result
    },

    async getRef(name) {
      if (!isRefName(name)) return undefined
      const ref = await backend.readRef(name)
      if (!ref || !(await backend.readMeta(ref.id))) return undefined
      return ref
    },

    async setRef(name, { id, meta }) {
      if (!isRefName(name)) throw new Error(`malformed ref name "${name}"`)
      if (!(await stat(id))) throw new Error(`artifact ${id} is not stored`)
      const ref: ArtifactRef = { id, ...(meta ? { meta } : {}), updatedAt: now().toISOString() }
      await backend.writeRef(name, ref)
      return ref
    },

    async deleteRef(name) {
      if (!isRefName(name) || !(await backend.readRef(name))) return false
      await backend.removeRef(name)
      return true
    },

    ...(backend.presign
      ? {
          async presign(id: string, presign: PresignOptions = {}) {
            const info = await stat(id)
            return info ? backend.presign?.(info, presign) : undefined
          },
        }
      : {}),
  }
}
