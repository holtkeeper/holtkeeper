import type { KvStore } from './types.ts'

/**
 * Writes `apply(current value)` to `key`, retrying up to `attempts` times when another write landed
 * in between (`compareAndSet`; a store without it writes once). Resolves with the written value, or
 * `undefined` when concurrent writes kept every attempt from landing.
 */
export async function updateKv<T>(
  kv: Pick<KvStore, 'get' | 'set' | 'compareAndSet'>,
  key: string,
  apply: (current: unknown) => T,
  attempts = 5,
): Promise<T | undefined> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    // oxlint-disable-next-line no-await-in-loop -- retried only when another write won
    const before = await kv.get(key)
    const next = apply(before)
    if (!kv.compareAndSet) {
      // oxlint-disable-next-line no-await-in-loop -- see above
      await kv.set(key, next)
      return next
    }
    // oxlint-disable-next-line no-await-in-loop -- see above
    if (await kv.compareAndSet(key, before, next)) return next
  }
  return undefined
}
