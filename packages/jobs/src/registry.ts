import { type KvStore, updateKv } from '@holtkeeper/store'

/** The KV key holding every worker's last sign of life as `{ [workerId]: lastSeen }`. */
export const WORKERS_KEY = 'workers'

/** Entries older than this are dead workers: readers drop them and the next write prunes them. */
export const WORKER_TTL_MS = 90_000

/** A worker that refreshed its registry entry within the TTL. */
export interface LiveWorker {
  id: string
  lastSeen: string
}

type Registry = Record<string, string>

type RegistryKv = Pick<KvStore, 'get' | 'set' | 'compareAndSet'>

const entriesOf = (value: unknown): Registry => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

const live = (registry: Registry, now: Date, ttlMs: number) => {
  const cutoff = now.getTime() - ttlMs
  return Object.entries(registry).filter(([, seen]) => Date.parse(seen) >= cutoff)
}

/**
 * Records that worker `id` is alive at `now` and drops entries older than `ttlMs`, through
 * `compareAndSet` retries so concurrent workers never overwrite each other's entries. `false` when
 * every attempt lost to a concurrent write.
 */
export async function touchWorker(
  kv: RegistryKv,
  id: string,
  now: Date,
  ttlMs = WORKER_TTL_MS,
): Promise<boolean> {
  const written = await updateKv(kv, WORKERS_KEY, (current) => ({
    ...Object.fromEntries(live(entriesOf(current), now, ttlMs)),
    [id]: now.toISOString(),
  }))
  return written !== undefined
}

/** Removes worker `id` from the registry, as a stopping worker does. */
export async function removeWorker(kv: RegistryKv, id: string): Promise<void> {
  await updateKv(kv, WORKERS_KEY, (current) => {
    const { [id]: _gone, ...rest } = entriesOf(current)
    return rest
  })
}

/** Workers seen within `ttlMs` of `now`, most recently seen first; stale entries are left out. */
export async function liveWorkers(
  kv: Pick<KvStore, 'get'>,
  now: Date,
  ttlMs = WORKER_TTL_MS,
): Promise<LiveWorker[]> {
  return live(entriesOf(await kv.get(WORKERS_KEY)), now, ttlMs)
    .map(([id, lastSeen]) => ({ id, lastSeen }))
    .toSorted((a, b) => b.lastSeen.localeCompare(a.lastSeen) || a.id.localeCompare(b.id))
}
