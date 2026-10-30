import type { FixAttempt } from '@holtkeeper/api'

/** The fixers tried for one source file, in the order they ran. */
export interface FixChain {
  source: string
  attempts: FixAttempt[]
  requested: number
  fixed: number
  failed: boolean
}

/**
 * Groups fix attempts by source file, keeping run order. `requested` is what the first fixer was
 * handed; `fixed` is what all fixers together claimed (the rescan decides what really went away).
 */
export function fixChains(attempts: readonly FixAttempt[]): FixChain[] {
  const chains = new Map<string, FixChain>()
  for (const attempt of attempts) {
    let chain = chains.get(attempt.source)
    if (!chain) {
      chain = {
        source: attempt.source,
        attempts: [],
        requested: attempt.requested.length,
        fixed: 0,
        failed: false,
      }
      chains.set(attempt.source, chain)
    }
    chain.attempts.push(attempt)
    chain.fixed += attempt.fixed.length
    chain.failed ||= attempt.error !== undefined
  }
  return [...chains.values()]
}
