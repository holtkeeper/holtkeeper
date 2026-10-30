import { type Clock, systemClock } from './clock.ts'
import { type KeyState, type LimiterState, freshState } from './state.ts'

/**
 * The part of a shared key-value store a `storeLimiterState` needs; `KvStore` from
 * `@holtkeeper/store` satisfies it when it implements `compareAndSet`.
 */
export interface LimiterKv {
  get(key: string): Promise<unknown>
  /**
   * Writes `value` only when the live value equals `expected` (as JSON, `undefined` = missing),
   * atomically across processes; `true` when written.
   */
  compareAndSet(
    key: string,
    expected: unknown,
    value: unknown,
    ttlSeconds?: number,
  ): Promise<boolean>
}

export interface StoreLimiterStateOptions {
  kv: LimiterKv
  /** Key prefix in the store. Default `limits:`. */
  prefix?: string
  /** Identifies this process among the ones sharing the store. Default: a random id. */
  processId?: string
  /** A key untouched for this long expires (and with it its daily counters). Default 2 days. */
  ttlSeconds?: number
  /**
   * Slots and reservations of a process that has not refreshed them for this long (it died while
   * holding leases) are given back. Default 2 minutes.
   */
  staleMs?: number
  /** How often slots this process holds are refreshed. Default 30 seconds. */
  heartbeatMs?: number
  /** Write conflicts in a row before `transact` gives up. Default 50. */
  maxConflicts?: number
  clock?: Clock
}

/** A `LimiterState` in a shared store whose held slots can be heartbeated and released. */
export interface StoreLimiterState extends LimiterState {
  /** Stops the heartbeat timer; slots still held expire after `staleMs`. */
  close(): void
}

interface Holder {
  inFlight: number
  reservedTokens: number
  at: number
}

interface Stored {
  state: KeyState
  /** What each process holds of `state.inFlight` and `state.reservedTokens`. */
  holders: Record<string, Holder>
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const isStored = (value: unknown): value is Stored =>
  typeof value === 'object' && value !== null && 'state' in value && 'holders' in value

/**
 * A `LimiterState` kept in a shared key-value store, so every process using the same store shares
 * one credential's limits. Each key is one JSON document updated with compare-and-set (retrying
 * `change` on conflicts, as the contract allows). In-flight slots and token reservations are
 * attributed to the process holding them, so a process that dies does not keep them forever: they
 * are returned once its heartbeat is older than `staleMs`.
 */
export function storeLimiterState(options: StoreLimiterStateOptions): StoreLimiterState {
  const { kv } = options
  const prefix = options.prefix ?? 'limits:'
  const self = options.processId ?? crypto.randomUUID()
  const ttlSeconds = options.ttlSeconds ?? 2 * 86_400
  const staleMs = options.staleMs ?? 120_000
  const heartbeatMs = options.heartbeatMs ?? 30_000
  const maxConflicts = options.maxConflicts ?? 50
  const clock = options.clock ?? systemClock
  const indexKey = `${prefix}keys`
  const keyOf = (key: string) => `${prefix}key:${key}`
  const indexed = new Set<string>()
  const held = new Set<string>()
  let cancelHeartbeat: (() => void) | undefined

  async function update<T>(key: string, apply: (current: unknown) => { next: unknown; result: T }) {
    for (let attempt = 0; attempt < maxConflicts; attempt++) {
      const current = await kv.get(key)
      const { next, result } = apply(current)
      if (await kv.compareAndSet(key, current, next, ttlSeconds)) return result
    }
    throw new Error(`limiter state ${key}: too many write conflicts`)
  }

  async function index(key: string) {
    if (indexed.has(key)) return
    await update(indexKey, (current) => {
      const keys = isStringArray(current) ? current : []
      return { next: keys.includes(key) ? keys : [...keys, key], result: undefined }
    })
    indexed.add(key)
  }

  const schedule = () => {
    if (held.size === 0) {
      cancelHeartbeat?.()
      cancelHeartbeat = undefined
    }
    if (cancelHeartbeat || held.size === 0) return
    cancelHeartbeat = clock.setTimer(() => {
      cancelHeartbeat = undefined
      void Promise.allSettled([...held].map((key) => transact(key, () => {}))).then(schedule)
    }, heartbeatMs)
  }

  async function transact<T>(key: string, change: (state: KeyState) => T): Promise<T> {
    const result = await update(keyOf(key), (current) => {
      const now = clock.now()
      const stored: Stored = isStored(current)
        ? structuredClone(current)
        : { state: freshState(now), holders: {} }
      const { state, holders } = stored
      for (const [id, holder] of Object.entries(holders)) {
        if (id === self || now - holder.at <= staleMs) continue
        state.inFlight = Math.max(0, state.inFlight - holder.inFlight)
        state.reservedTokens = Math.max(0, state.reservedTokens - holder.reservedTokens)
        delete holders[id]
      }
      const before = { inFlight: state.inFlight, reservedTokens: state.reservedTokens }
      const value = change(state)
      const mine = holders[self] ?? { inFlight: 0, reservedTokens: 0, at: now }
      mine.inFlight = Math.max(0, mine.inFlight + state.inFlight - before.inFlight)
      mine.reservedTokens = Math.max(
        0,
        mine.reservedTokens + state.reservedTokens - before.reservedTokens,
      )
      mine.at = now
      if (mine.inFlight > 0 || mine.reservedTokens > 0) holders[self] = mine
      else delete holders[self]
      return { next: stored, result: { value, holding: self in holders } }
    })
    await index(key)
    if (result.holding) held.add(key)
    else held.delete(key)
    schedule()
    return result.value
  }

  return {
    transact,
    async read(key) {
      const current = await kv.get(keyOf(key))
      return isStored(current) ? { ...current.state } : undefined
    },
    async keys() {
      const current = await kv.get(indexKey)
      return isStringArray(current) ? current : []
    },
    close() {
      cancelHeartbeat?.()
      cancelHeartbeat = undefined
      held.clear()
    },
  }
}
