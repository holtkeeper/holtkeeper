/**
 * Counters of one limiter key. Plain JSON data so a shared store can persist it. Bucket levels are
 * `undefined` until the key is first used with that rate (a fresh bucket is full).
 */
export interface KeyState {
  inFlight: number
  requestLevel?: number
  requestAt?: number
  tokenLevel?: number
  tokenAt?: number
  /** Tokens estimated for leases still held; counted against the daily cap until released. */
  reservedTokens: number
  /** No lease is granted before this time (ms since the epoch). */
  coolDownUntil?: number
  last429At?: number
  /** Throttles in a row without a clean release; drives exponential backoff. */
  strikes: number
  /** UTC day (`YYYY-MM-DD`) the daily counters belong to. */
  day: string
  dayTokens: number
  dayCostUsd: number
}

/**
 * Where a limiter keeps its counters. The default is in-process (`memoryLimiterState`); a
 * store-backed implementation (Postgres row per key, Redis hash, ...) makes several server
 * processes share one credential's limits.
 *
 * Contract for implementations:
 * - `transact` runs `change` on a copy of the key's current state (a fresh state when the key is
 *   new) and stores the result atomically with respect to other `transact` calls on the same key,
 *   in this and every other process. On a write conflict it re-reads and runs `change` again, so
 *   `change` must be synchronous and depend only on its argument. If `change` throws nothing is
 *   stored.
 * - Queues stay in-process: each process keeps its own FIFO and re-checks the shared counters when
 *   its local leases are released, when a computed refill time passes, and every `pollMs` while
 *   waiting for a slot held elsewhere.
 * - Daily counters may be expired after their day has passed.
 */
export interface LimiterState {
  transact<T>(key: string, change: (state: KeyState) => T): Promise<T>
  read(key: string): Promise<KeyState | undefined>
  keys(): Promise<string[]>
}

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export const freshState = (now: number): KeyState => ({
  inFlight: 0,
  reservedTokens: 0,
  strikes: 0,
  day: utcDay(now),
  dayTokens: 0,
  dayCostUsd: 0,
})

/** In-process `LimiterState`; state is lost on restart and not shared between processes. */
export function memoryLimiterState(now: () => number = Date.now): LimiterState {
  const states = new Map<string, KeyState>()
  return {
    async transact(key, change) {
      const copy = { ...(states.get(key) ?? freshState(now())) }
      const result = change(copy)
      states.set(key, copy)
      return result
    },
    async read(key) {
      const state = states.get(key)
      return state && { ...state }
    },
    async keys() {
      return [...states.keys()]
    },
  }
}
