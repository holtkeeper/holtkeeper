import type { PolicyMemory } from './model.ts'

/** A `PolicyMemory` that lives as long as the process; keeps at most `limit` keys, oldest dropped first. */
export function createMemory(limit = 10_000): PolicyMemory {
  const keys = new Set<string>()
  return {
    seen: (key) => keys.has(key),
    remember(key) {
      keys.delete(key)
      keys.add(key)
      while (keys.size > limit) {
        const oldest = keys.values().next()
        if (oldest.done) break
        keys.delete(oldest.value)
      }
    },
  }
}
