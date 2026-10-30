import { canonicalJson } from './audit.ts'
import type {
  AnyConfigDocument,
  ConfigDocument,
  ConfigDocumentType,
  ConfigRevision,
  ConfigStore,
  KvLease,
  KvStore,
} from './types.ts'

const clone = <T>(value: T): T => structuredClone(value)

/** Whether a stored value is a `KvLease`. */
export const isKvLease = (value: unknown): value is KvLease =>
  typeof value === 'object' &&
  value !== null &&
  'holder' in value &&
  typeof value.holder === 'string' &&
  'expiresAt' in value &&
  typeof value.expiresAt === 'string'

const key = (type: string, id: string) => `${type}\u0000${id}`

/** Orders documents by type, then id, as `ConfigStore.list` promises. */
export const compareConfigDocuments = (
  a: { type: string; id: string },
  b: { type: string; id: string },
) => (a.type < b.type ? -1 : a.type > b.type ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** The in-memory `ConfigStore`. */
export function memoryConfig(): ConfigStore {
  const documents = new Map<string, AnyConfigDocument>()
  const histories = new Map<string, ConfigRevision[]>()

  function list<T extends ConfigDocumentType>(type: T): Promise<ConfigDocument<T>[]>
  function list(): Promise<AnyConfigDocument[]>
  async function list(type?: ConfigDocumentType) {
    return [...documents.values()]
      .filter((document) => type === undefined || document.type === type)
      .toSorted(compareConfigDocuments)
      .map(clone)
  }

  return {
    async put(input) {
      const k = key(input.type, input.id)
      const previous = documents.get(k)
      if (previous) {
        const revision: ConfigRevision = {
          version: previous.version,
          data: clone(previous.data),
          updatedAt: previous.updatedAt,
          ...(previous.updatedBy !== undefined && { updatedBy: previous.updatedBy }),
        }
        histories.set(k, [revision, ...(histories.get(k) ?? [])])
      }
      const stored = { ...clone(input), version: (previous?.version ?? 0) + 1 }
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `stored.data` matches `stored.type`
      documents.set(k, stored as AnyConfigDocument)
      return clone(stored)
    },
    get: async <T extends ConfigDocumentType>(type: T, id: string) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- looked up by type
      clone(documents.get(key(type, id))) as ConfigDocument<T> | undefined,
    list,
    history: async <T extends ConfigDocumentType>(type: T, id: string) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- revisions of `type` hold its data
      clone(histories.get(key(type, id)) ?? []) as ConfigRevision<T>[],
    async remove(type, id) {
      documents.delete(key(type, id))
      histories.delete(key(type, id))
    },
  }
}

/** The in-memory `KvStore`. */
export function memoryKv(): KvStore {
  const entries = new Map<string, { value: unknown; expiresAt?: number }>()
  const live = (k: string, at = Date.now()) => {
    const entry = entries.get(k)
    if (!entry) return undefined
    if (entry.expiresAt !== undefined && entry.expiresAt <= at) {
      entries.delete(k)
      return undefined
    }
    return entry
  }
  return {
    get: async (k) => clone(live(k)?.value),
    async set(k, value, ttlSeconds) {
      if (ttlSeconds !== undefined && !(ttlSeconds > 0)) throw new Error('ttlSeconds must be > 0')
      entries.set(k, {
        value: clone(value),
        ...(ttlSeconds !== undefined && { expiresAt: Date.now() + ttlSeconds * 1000 }),
      })
    },
    delete: async (k) => void entries.delete(k),
    async acquireLease(k, holder, ttlSeconds, now = new Date()) {
      if (!(ttlSeconds > 0)) throw new Error('ttlSeconds must be > 0')
      const at = now.getTime()
      const current = live(k, at)?.value
      if (isKvLease(current) && current.holder !== holder) return clone(current)
      const expiresAt = at + ttlSeconds * 1000
      const lease: KvLease = { holder, expiresAt: new Date(expiresAt).toISOString() }
      entries.set(k, { value: lease, expiresAt })
      return clone(lease)
    },
    async releaseLease(k, holder) {
      const current = entries.get(k)?.value
      if (!isKvLease(current) || current.holder !== holder) return false
      entries.delete(k)
      return true
    },
    async compareAndSet(k, expected, value, ttlSeconds) {
      if (ttlSeconds !== undefined && !(ttlSeconds > 0)) throw new Error('ttlSeconds must be > 0')
      const current = live(k)
      const same = current
        ? expected !== undefined && canonicalJson(current.value) === canonicalJson(expected)
        : expected === undefined
      if (!same) return false
      entries.set(k, {
        value: clone(value),
        ...(ttlSeconds !== undefined && { expiresAt: Date.now() + ttlSeconds * 1000 }),
      })
      return true
    },
    async sweep(now = new Date()) {
      let removed = 0
      for (const k of entries.keys()) {
        const before = entries.has(k)
        live(k, now.getTime())
        if (before && !entries.has(k)) removed++
      }
      return removed
    },
  }
}
