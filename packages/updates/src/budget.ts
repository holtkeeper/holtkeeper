/** One repository polling wants to keep up with. */
export interface PollDemand {
  /** Limiter key of the repository's forge credential. */
  key: string
  /** Interval the repository's settings ask for. */
  intervalMs: number
  /** Requests one poll is expected to take. */
  cost: number
}

/** Request budget of one key for polling. */
export interface KeyBudget {
  /** Requests per minute polling may spend on the key; `undefined` is unlimited. */
  requestsPerMinute: number | undefined
}

/** Default share of a key's `requestsPerMinute` polling may spend. */
export const DEFAULT_POLL_SHARE = 0.2

/**
 * How much slower than asked every repository of a key must be polled so that, together, they
 * stay within the key's budget: 1 when the budget suffices, more otherwise. Every repository of a
 * key is slowed by the same factor, so none is starved.
 */
export function stretchFactors(
  demands: readonly PollDemand[],
  budgetOf: (key: string) => KeyBudget,
): Map<string, number> {
  const perMinute = new Map<string, number>()
  for (const demand of demands)
    perMinute.set(
      demand.key,
      (perMinute.get(demand.key) ?? 0) + (demand.cost * 60_000) / demand.intervalMs,
    )
  const factors = new Map<string, number>()
  for (const [key, wanted] of perMinute) {
    const budget = budgetOf(key).requestsPerMinute
    factors.set(key, budget === undefined || budget <= 0 ? 1 : Math.max(1, wanted / budget))
  }
  return factors
}

/** 32-bit FNV-1a: the same repository always lands on the same phase. */
function hash(value: string): number {
  let result = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 0x01000193)
  }
  return result >>> 0
}

/**
 * When a repository that was never polled is first due: a stable point within one interval from
 * `now`, so repositories sharing a key do not all start at once.
 */
export function firstDueAt(repoKey: string, now: number, intervalMs: number): number {
  return now + (hash(repoKey) % Math.max(1, Math.floor(intervalMs / 1000))) * 1000
}

/**
 * Requests spent on each key in the last minute, so a tick does not start more polls than the
 * key's budget allows even when many are due at once.
 */
export function createSpendWindow(windowMs = 60_000) {
  const spent = new Map<string, { at: number; requests: number }[]>()
  const recent = (key: string, now: number) => {
    const list = (spent.get(key) ?? []).filter((entry) => now - entry.at < windowMs)
    spent.set(key, list)
    return list
  }
  return {
    /** Requests spent on `key` within the window ending at `now`. */
    used(key: string, now: number) {
      return recent(key, now).reduce((sum, entry) => sum + entry.requests, 0)
    },
    record(key: string, now: number, requests: number) {
      recent(key, now).push({ at: now, requests })
    },
  }
}
