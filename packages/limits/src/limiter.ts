import { type Clock, systemClock } from './clock.ts'
import type { ThrottleHint } from './headers.ts'
import { DEFAULT_BACKOFF, type LimitPolicy } from './policy.ts'
import {
  type KeyState,
  type LimiterState,
  freshState,
  memoryLimiterState,
  utcDay,
} from './state.ts'

/** What one lease consumes. */
export interface AcquireRequest {
  /** Request units; default 1. */
  requests?: number
  /** Estimated AI tokens, corrected on release; default 0. */
  tokens?: number
}

/** What a lease actually used, reported on release. */
export interface LeaseUsage {
  /** Actual AI tokens; replaces the estimate in per-minute and daily accounting. */
  tokens?: number
  costUsd?: number
}

/** Capacity granted by `acquire`. Hold it while the work runs, then release it exactly once. */
export interface Lease {
  readonly key: string
  /** Tokens reserved up front. */
  readonly tokens: number
  /** Frees the concurrency slot and records usage. Later calls do nothing. */
  release(usage?: LeaseUsage): Promise<void>
  /** Reports that the work hit a rate limit: starts a cool-down shared by every user of the key. */
  throttle(hint?: ThrottleHint): Promise<void>
}

/** A daily cap of a key is used up; retrying before `resetsAt` fails the same way. */
export class LimitExceededError extends Error {
  override name = 'LimitExceededError'
  readonly key: string
  readonly limit: 'tokensPerDay' | 'costPerDayUsd'
  /** Next UTC midnight, ISO 8601. */
  readonly resetsAt: string

  constructor(key: string, limit: 'tokensPerDay' | 'costPerDayUsd', resetsAt: string) {
    super(`limit ${limit} of "${key}" is used up until ${resetsAt}`)
    this.key = key
    this.limit = limit
    this.resetsAt = resetsAt
  }
}

/** Metrics of one key at the time of the snapshot. */
export interface KeySnapshot {
  inFlight: number
  queued: number
  /** Request units available now; omitted without `requestsPerMinute`. */
  requestsLeft?: number
  /** AI tokens available now; omitted without `tokensPerMinute`. */
  tokensLeft?: number
  /** ISO 8601; present while a cool-down is active. */
  coolDownUntil?: string
  /** ISO 8601 time of the last throttle. */
  last429At?: string
  dayTokens: number
  dayCostUsd: number
}

/**
 * Shares the capacity of credentials between concurrent callers. Each key (a credential id) has
 * one policy, a FIFO queue, token buckets, a semaphore and a cool-down. A key without a policy is
 * unlimited but still honors cool-downs.
 */
export interface Limiter {
  /** Sets the policy of `key`; the latest call wins and applies to waiting callers too. */
  configure(key: string, policy: LimitPolicy): void
  policy(key: string): LimitPolicy | undefined
  /**
   * Waits until the request fits, in arrival order per key: a waiting caller is never overtaken
   * by a later one on the same key. Rejects with the signal's reason when it aborts while
   * waiting, and with `LimitExceededError` when a daily cap is used up.
   */
  acquire(key: string, request?: AcquireRequest, signal?: AbortSignal): Promise<Lease>
  /** Like `Lease.throttle`, without holding a lease. */
  throttle(key: string, hint?: ThrottleHint): Promise<void>
  /**
   * True when a new caller would have to wait or be denied right now: cool-down active, callers
   * queued, all slots in use, or a daily cap used up.
   */
  saturated(key: string): Promise<boolean>
  snapshot(): Promise<Record<string, KeySnapshot>>
}

export interface LimiterOptions {
  /** Default: in-process memory. */
  state?: LimiterState
  clock?: Clock
  /** How often a caller waiting for a slot re-checks a shared state. Default 1 s. */
  pollMs?: number
}

const MINUTE = 60_000

type Decision =
  | { type: 'grant' }
  | { type: 'wait'; until: number }
  | { type: 'slot' }
  | { type: 'deny'; limit: 'tokensPerDay' | 'costPerDayUsd' }

interface Need {
  requests: number
  tokens: number
}

interface Waiter {
  need: Need
  settled: boolean
  resolve(lease: Lease): void
  reject(error: unknown): void
  detach(): void
}

interface Lane {
  queue: Waiter[]
  pumping: boolean
  again: boolean
  cancelTimer?: () => void
}

const nextMidnight = (now: number) => {
  const date = new Date(now)
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1),
  ).toISOString()
}

function rollDay(state: KeyState, now: number) {
  const day = utcDay(now)
  if (state.day === day) return
  state.day = day
  state.dayTokens = 0
  state.dayCostUsd = 0
}

function refill(state: KeyState, policy: LimitPolicy, now: number) {
  const rpm = policy.requestsPerMinute
  if (rpm !== undefined) {
    const capacity = policy.burst ?? rpm
    const elapsed = state.requestAt === undefined ? 0 : Math.max(0, now - state.requestAt)
    state.requestLevel = Math.min(
      capacity,
      (state.requestLevel ?? capacity) + (elapsed * rpm) / MINUTE,
    )
    state.requestAt = now
  }
  const tpm = policy.tokensPerMinute
  if (tpm !== undefined) {
    const elapsed = state.tokenAt === undefined ? 0 : Math.max(0, now - state.tokenAt)
    state.tokenLevel = Math.min(tpm, (state.tokenLevel ?? tpm) + (elapsed * tpm) / MINUTE)
    state.tokenAt = now
  }
}

/** Time until a bucket at `level` holds `need` (capped to its capacity, so big asks fit when full). */
const refillWait = (level: number, need: number, capacity: number, perMinute: number) => {
  const target = Math.min(need, capacity)
  return level >= target ? 0 : Math.ceil(((target - level) * MINUTE) / perMinute)
}

function decide(state: KeyState, policy: LimitPolicy, need: Need, now: number): Decision {
  rollDay(state, now)
  refill(state, policy, now)
  if (state.coolDownUntil !== undefined && state.coolDownUntil > now) {
    return { type: 'wait', until: state.coolDownUntil }
  }
  if (policy.tokensPerDay !== undefined) {
    const used = state.dayTokens + state.reservedTokens
    if (used >= policy.tokensPerDay || used + need.tokens > policy.tokensPerDay) {
      return { type: 'deny', limit: 'tokensPerDay' }
    }
  }
  if (policy.costPerDayUsd !== undefined && state.dayCostUsd >= policy.costPerDayUsd) {
    return { type: 'deny', limit: 'costPerDayUsd' }
  }
  if (policy.maxConcurrent !== undefined && state.inFlight >= policy.maxConcurrent) {
    return { type: 'slot' }
  }
  let wait = 0
  if (policy.requestsPerMinute !== undefined && need.requests > 0) {
    const capacity = policy.burst ?? policy.requestsPerMinute
    wait = Math.max(
      wait,
      refillWait(state.requestLevel ?? capacity, need.requests, capacity, policy.requestsPerMinute),
    )
  }
  if (policy.tokensPerMinute !== undefined && need.tokens > 0) {
    const capacity = policy.tokensPerMinute
    wait = Math.max(wait, refillWait(state.tokenLevel ?? capacity, need.tokens, capacity, capacity))
  }
  if (wait > 0) return { type: 'wait', until: now + wait }

  state.inFlight += 1
  if (state.requestLevel !== undefined) state.requestLevel -= need.requests
  if (state.tokenLevel !== undefined) state.tokenLevel -= need.tokens
  state.reservedTokens += need.tokens
  return { type: 'grant' }
}

function settleLease(
  state: KeyState,
  policy: LimitPolicy,
  need: Need,
  now: number,
  outcome: { usage?: LeaseUsage; throttled: boolean; refund: boolean },
) {
  rollDay(state, now)
  refill(state, policy, now)
  state.inFlight = Math.max(0, state.inFlight - 1)
  state.reservedTokens = Math.max(0, state.reservedTokens - need.tokens)
  if (outcome.refund) {
    if (state.requestLevel !== undefined) state.requestLevel += need.requests
    if (state.tokenLevel !== undefined) state.tokenLevel += need.tokens
    refill(state, policy, now)
    return
  }
  const actual = outcome.usage?.tokens ?? need.tokens
  if (state.tokenLevel !== undefined && policy.tokensPerMinute !== undefined) {
    state.tokenLevel = Math.min(policy.tokensPerMinute, state.tokenLevel + need.tokens - actual)
  }
  state.dayTokens += actual
  state.dayCostUsd += outcome.usage?.costUsd ?? 0
  if (!outcome.throttled) state.strikes = 0
}

function coolDown(
  state: KeyState,
  policy: LimitPolicy,
  now: number,
  hint: ThrottleHint | undefined,
) {
  const backoff = policy.backoff ?? DEFAULT_BACKOFF
  const cooling = state.coolDownUntil !== undefined && state.coolDownUntil > now
  if (!cooling) state.strikes += 1
  const exponential = backoff.baseMs * 2 ** Math.max(0, state.strikes - 1)
  const delay = Math.min(backoff.maxMs, hint?.delayMs ?? exponential)
  state.coolDownUntil = Math.max(state.coolDownUntil ?? 0, now + delay)
  state.last429At = now
}

/** Creates a limiter. Without `state` its counters live in this process only. */
export function createLimiter(options: LimiterOptions = {}): Limiter {
  const clock = options.clock ?? systemClock
  const state = options.state ?? memoryLimiterState(() => clock.now())
  const pollMs = options.pollMs ?? 1000
  const policies = new Map<string, LimitPolicy>()
  const lanes = new Map<string, Lane>()

  const laneOf = (key: string) => {
    let lane = lanes.get(key)
    if (!lane) {
      lane = { queue: [], pumping: false, again: false }
      lanes.set(key, lane)
    }
    return lane
  }
  const policyOf = (key: string) => policies.get(key) ?? {}

  const wake = (key: string) => void pump(key)

  const schedule = (key: string, lane: Lane, ms: number) => {
    lane.cancelTimer?.()
    lane.cancelTimer = clock.setTimer(() => {
      lane.cancelTimer = undefined
      wake(key)
    }, ms)
  }

  function makeLease(key: string, need: Need): { lease: Lease; refund: () => Promise<void> } {
    let released = false
    let throttled = false
    const finish = async (usage: LeaseUsage | undefined, refund: boolean) => {
      if (released) return
      released = true
      const now = clock.now()
      try {
        await state.transact(key, (s) =>
          settleLease(s, policyOf(key), need, now, { ...(usage && { usage }), throttled, refund }),
        )
      } finally {
        wake(key)
      }
    }
    const lease: Lease = {
      key,
      tokens: need.tokens,
      release: (usage) => finish(usage, false),
      async throttle(hint) {
        throttled = true
        await limiter.throttle(key, hint)
      },
    }
    return { lease, refund: () => finish(undefined, true) }
  }

  async function pump(key: string): Promise<void> {
    const lane = laneOf(key)
    if (lane.pumping) {
      lane.again = true
      return
    }
    lane.pumping = true
    try {
      do {
        lane.again = false
        lane.cancelTimer?.()
        lane.cancelTimer = undefined
        while (lane.queue.length > 0) {
          const head = lane.queue[0]
          if (!head) break
          if (head.settled) {
            lane.queue.shift()
            continue
          }
          const now = clock.now()
          let decision: Decision
          try {
            decision = await state.transact(key, (s) => decide(s, policyOf(key), head.need, now))
          } catch {
            schedule(key, lane, pollMs)
            break
          }
          if (decision.type === 'grant') {
            const { lease, refund } = makeLease(key, head.need)
            if (head.settled) {
              await refund()
              continue
            }
            removeWaiter(lane, head)
            head.resolve(lease)
            continue
          }
          if (decision.type === 'deny') {
            removeWaiter(lane, head)
            head.reject(new LimitExceededError(key, decision.limit, nextMidnight(now)))
            continue
          }
          if (decision.type === 'wait') schedule(key, lane, decision.until - now)
          else schedule(key, lane, pollMs)
          break
        }
      } while (lane.again)
    } finally {
      lane.pumping = false
    }
  }

  const removeWaiter = (lane: Lane, waiter: Waiter) => {
    waiter.settled = true
    waiter.detach()
    const index = lane.queue.indexOf(waiter)
    if (index >= 0) lane.queue.splice(index, 1)
  }

  const read = async (key: string) => {
    const now = clock.now()
    const current = (await state.read(key)) ?? freshState(now)
    rollDay(current, now)
    refill(current, policyOf(key), now)
    return current
  }

  const limiter: Limiter = {
    configure(key, policy) {
      policies.set(key, policy)
      wake(key)
    },

    policy: (key) => policies.get(key),

    acquire(key, request = {}, signal) {
      if (signal?.aborted) return Promise.reject(signal.reason)
      const need = { requests: request.requests ?? 1, tokens: request.tokens ?? 0 }
      const lane = laneOf(key)
      return new Promise<Lease>((resolve, reject) => {
        const onAbort = () => {
          if (waiter.settled) return
          removeWaiter(lane, waiter)
          reject(signal?.reason)
          wake(key)
        }
        const waiter: Waiter = {
          need,
          settled: false,
          resolve,
          reject,
          detach: () => signal?.removeEventListener('abort', onAbort),
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        lane.queue.push(waiter)
        wake(key)
      })
    },

    async throttle(key, hint) {
      const now = clock.now()
      await state.transact(key, (s) => coolDown(s, policyOf(key), now, hint))
      wake(key)
    },

    async saturated(key) {
      if ((lanes.get(key)?.queue.length ?? 0) > 0) return true
      const current = await read(key)
      const now = clock.now()
      const policy = policyOf(key)
      return (
        (current.coolDownUntil !== undefined && current.coolDownUntil > now) ||
        (policy.maxConcurrent !== undefined && current.inFlight >= policy.maxConcurrent) ||
        (policy.tokensPerDay !== undefined &&
          current.dayTokens + current.reservedTokens >= policy.tokensPerDay) ||
        (policy.costPerDayUsd !== undefined && current.dayCostUsd >= policy.costPerDayUsd)
      )
    },

    async snapshot() {
      const now = clock.now()
      const keys = new Set([...policies.keys(), ...lanes.keys(), ...(await state.keys())])
      const result: Record<string, KeySnapshot> = {}
      for (const key of [...keys].toSorted()) {
        const current = await read(key)
        const queued = lanes.get(key)?.queue.length ?? 0
        result[key] = {
          inFlight: current.inFlight ?? 0,
          queued,
          ...(current.requestLevel !== undefined && {
            requestsLeft: Math.max(0, Math.floor(current.requestLevel)),
          }),
          ...(current.tokenLevel !== undefined && {
            tokensLeft: Math.max(0, Math.floor(current.tokenLevel)),
          }),
          ...(current.coolDownUntil !== undefined &&
            current.coolDownUntil > now && {
              coolDownUntil: new Date(current.coolDownUntil).toISOString(),
            }),
          ...(current.last429At !== undefined && {
            last429At: new Date(current.last429At).toISOString(),
          }),
          dayTokens: current.dayTokens ?? 0,
          dayCostUsd: current.dayCostUsd ?? 0,
        }
      }
      return result
    },
  }
  return limiter
}
