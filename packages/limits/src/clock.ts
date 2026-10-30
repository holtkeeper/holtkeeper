/** Time source and timers of a limiter; injected so tests control time. */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number
  /** Calls `fn` once after `ms`; the returned function cancels it. */
  setTimer(fn: () => void, ms: number): () => void
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer(fn, ms) {
    const handle = setTimeout(fn, Math.max(0, ms))
    return () => clearTimeout(handle)
  },
}

/** A clock that only moves when told to; for tests. */
export interface ManualClock extends Clock {
  /** Moves time forward, firing due timers in order and letting their promise chains settle. */
  advance(ms: number): Promise<void>
  /** Timers not fired or canceled yet. */
  readonly pending: number
}

/** Lets every queued promise reaction run. */
export const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Creates a `ManualClock` starting at `start` (ms since the epoch). */
export function createManualClock(start = Date.parse('2026-10-30T10:00:00.000Z')): ManualClock {
  let current = start
  let nextId = 0
  const timers = new Map<number, { at: number; fn: () => void }>()

  const due = (until: number) => {
    let best: [number, { at: number; fn: () => void }] | undefined
    for (const entry of timers) {
      if (entry[1].at > until) continue
      if (!best || entry[1].at < best[1].at || (entry[1].at === best[1].at && entry[0] < best[0])) {
        best = entry
      }
    }
    return best
  }

  return {
    now: () => current,
    setTimer(fn, ms) {
      const id = nextId++
      timers.set(id, { at: current + Math.max(0, ms), fn })
      return () => {
        timers.delete(id)
      }
    },
    get pending() {
      return timers.size
    },
    async advance(ms) {
      const target = current + ms
      await settle()
      for (let next = due(target); next; next = due(target)) {
        timers.delete(next[0])
        current = Math.max(current, next[1].at)
        next[1].fn()
        await settle()
      }
      current = target
      await settle()
    },
  }
}
