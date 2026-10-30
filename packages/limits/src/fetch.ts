import { retryDelayFrom } from './headers.ts'
import type { Limiter } from './limiter.ts'
import { DEFAULT_BACKOFF, type LimitPolicy } from './policy.ts'

/** A `fetch` that may be called without `init`; the global `fetch` satisfies it. */
export type LimitedFetch = (input: string, init?: RequestInit) => Promise<Response>

export interface LimitFetchOptions {
  /** Retries of a rate-limited request after the shared cool-down. Default 3. */
  retries?: number
  /** Current time for header parsing; default `Date.now`. Pass the limiter's clock in tests. */
  now?: () => number
}

/**
 * Wraps `fetch` so every request takes one unit of `key`'s limits (the slot is held until the
 * response headers arrive). A response with a status in `policy.backoff.onStatus` starts a
 * cool-down for all users of the key (from `Retry-After` and reset headers, else exponential
 * backoff) and is retried after it, up to `retries` times; the last such response is returned
 * as is. `init.signal` aborts waiting as well as the request.
 */
export function limitFetch(
  fetch: (input: string, init: RequestInit) => Promise<Response>,
  limiter: Limiter,
  key: string,
  policy: LimitPolicy,
  options: LimitFetchOptions = {},
): LimitedFetch {
  limiter.configure(key, policy)
  const retries = options.retries ?? 3
  const now = options.now ?? Date.now
  const onStatus = policy.backoff?.onStatus ?? DEFAULT_BACKOFF.onStatus

  return async (input, init = {}) => {
    for (let attempt = 0; ; attempt++) {
      const lease = await limiter.acquire(key, { requests: 1 }, init.signal ?? undefined)
      let response: Response
      try {
        response = await fetch(input, init)
      } catch (error) {
        await lease.release()
        throw error
      }
      if (!onStatus.includes(response.status)) {
        await lease.release()
        return response
      }
      const delayMs = retryDelayFrom(response.headers, now())
      await lease.throttle(delayMs === undefined ? {} : { delayMs })
      await lease.release()
      if (attempt >= retries) return response
      await response.body?.cancel()
    }
  }
}
