import type { AgentResult, AgentUsage } from '@holtkeeper/agent'
import type { AiCostSource } from '@holtkeeper/store'

/** USD per million tokens of each kind. */
export interface ModelPrice {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** Prices per model id, used only when the provider does not report a cost. */
export type ModelPrices = Readonly<Record<string, ModelPrice>>

const price = (input: number, output: number, cacheRead = input * 0.1): ModelPrice => ({
  input,
  output,
  cacheRead,
  cacheWrite: input * 1.25,
})

/**
 * Anthropic first-party list prices as of 2026-10 (cache writes at the 5-minute rate). Prices
 * change; pass your own table to `meteredAgent` / `usageRecorder` when they do.
 */
export const defaultPrices: ModelPrices = {
  'claude-fable-5-1': price(10, 50, 0.25),
  'claude-fable-5': price(10, 50),
  'claude-opus-5-5': price(4, 20, 0.2),
  'claude-opus-5': price(5, 25),
  'claude-opus-4-8': price(5, 25),
  'claude-opus-4-7': price(5, 25),
  'claude-opus-4-6': price(5, 25),
  'claude-sonnet-5-5': price(2, 10, 0.2),
  'claude-sonnet-5': price(2, 10),
  'claude-sonnet-4-6': price(3, 15),
  'claude-haiku-5-5': price(0.1, 0.5),
  'claude-haiku-4-5': price(1, 5),
}

/**
 * The price for a model id: an exact entry, else the longest entry the id contains (so
 * `anthropic.claude-opus-5-5` and `claude-opus-5-5[1m]` find `claude-opus-5-5`).
 */
export function priceFor(
  model: string,
  prices: ModelPrices = defaultPrices,
): ModelPrice | undefined {
  if (prices[model]) return prices[model]
  const match = Object.keys(prices)
    .filter((id) => model.includes(id))
    .toSorted((a, b) => b.length - a.length)[0]
  return match === undefined ? undefined : prices[match]
}

/** USD for the given token counts. */
export const computeCost = (usage: AgentUsage, p: ModelPrice): number =>
  (usage.inputTokens * p.input +
    usage.outputTokens * p.output +
    usage.cacheReadTokens * p.cacheRead +
    usage.cacheWriteTokens * p.cacheWrite) /
  1_000_000

export const emptyUsage = (): AgentUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

/** A reported cost wins; otherwise it is computed from tokens when the model has a price. */
export function costOf(
  result: Pick<AgentResult, 'costUsd' | 'usage'>,
  model: string,
  prices: ModelPrices = defaultPrices,
): { costUsd: number; costSource: AiCostSource } {
  if (typeof result.costUsd === 'number' && Number.isFinite(result.costUsd))
    return { costUsd: result.costUsd, costSource: 'reported' }
  const p = priceFor(model, prices)
  if (result.usage && p) return { costUsd: computeCost(result.usage, p), costSource: 'computed' }
  return { costUsd: 0, costSource: 'unknown' }
}
