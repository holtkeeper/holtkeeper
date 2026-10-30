import type { HoltkeeperConfig } from '@holtkeeper/core'
import { type LimiterOptions, type StoreLimiterState, storeLimiterState } from '@holtkeeper/limits'
import type { Store } from '@holtkeeper/store'

/**
 * Limiter options for the server: with `limits.distributed: true` the counters live in the
 * store's `kv` (shared by every process on that store), otherwise in process memory. Throws when
 * distributed limits are asked for but the store's `kv` has no `compareAndSet`.
 */
export function limiterOptionsFor(
  config: Pick<HoltkeeperConfig, 'limits'>,
  store: Pick<Store, 'kv'>,
): LimiterOptions & { state?: StoreLimiterState } {
  if (!config.limits?.distributed) return {}
  const kv = store.kv
  const compareAndSet = kv?.compareAndSet?.bind(kv)
  if (!kv || !compareAndSet)
    throw new Error('limits.distributed needs a store whose kv implements compareAndSet')
  return { state: storeLimiterState({ kv: { get: (key) => kv.get(key), compareAndSet } }) }
}
