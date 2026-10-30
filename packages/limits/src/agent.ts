import type { Agent, AgentTask, AgentUsage } from '@holtkeeper/agent'

import { throttleHintFrom } from './headers.ts'
import type { Limiter } from './limiter.ts'
import { DEFAULT_BACKOFF, type LimitPolicy } from './policy.ts'

export interface LimitAgentOptions {
  /** Up-front token estimate of a run; default: prompt, system and context characters / 4. */
  estimateTokens?: (task: AgentTask) => number
  /** Current time for header parsing; default `Date.now`. */
  now?: () => number
}

/** Characters / 4 of everything the run sends first; a rough lower bound of what it uses. */
export const estimatePromptTokens = (task: AgentTask) =>
  Math.ceil((task.prompt.length + (task.system?.length ?? 0) + (task.context?.length ?? 0)) / 4)

/** Tokens a run counts against per-minute and daily limits: input, output and cache writes. */
export const usageTokens = (usage: AgentUsage) =>
  usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens

/**
 * Wraps an agent so every run holds one slot and one request unit of `key` and reserves its
 * estimated tokens up front; a run that would exceed `tokensPerMinute` waits. On completion the
 * estimate is replaced by `result.usage` and `result.costUsd` is counted. Daily caps reject runs
 * with `LimitExceededError` before they start. A rate-limit failure starts the key's shared
 * cool-down and is rethrown; runs are not retried, since they may have changed the checkout.
 */
export function limitAgent(
  agent: Agent,
  limiter: Limiter,
  key: string,
  policy: LimitPolicy,
  options: LimitAgentOptions = {},
): Agent {
  limiter.configure(key, policy)
  const estimate = options.estimateTokens ?? estimatePromptTokens
  const now = options.now ?? Date.now
  const onStatus = policy.backoff?.onStatus ?? DEFAULT_BACKOFF.onStatus

  return {
    name: agent.name,
    async run(task) {
      const lease = await limiter.acquire(key, { requests: 1, tokens: estimate(task) }, task.signal)
      try {
        const result = await agent.run(task)
        await lease.release({
          ...(result.usage && { tokens: usageTokens(result.usage) }),
          ...(result.costUsd !== undefined && { costUsd: result.costUsd }),
        })
        return result
      } catch (error) {
        const hint = throttleHintFrom(error, onStatus, now())
        if (hint) await lease.throttle(hint)
        await lease.release()
        throw error
      }
    },
  }
}
