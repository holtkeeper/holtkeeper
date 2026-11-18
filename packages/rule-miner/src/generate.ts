import type { Agent } from '@holtkeeper/agent'
import { learningKey } from '@holtkeeper/rules'

import type { ReviewComment } from './evidence.ts'
import {
  MINER_CONTEXT,
  MINER_SYSTEM,
  type MinerOutput,
  type MinerPromptInput,
  minerOutput,
  minerPrompt,
} from './prompt.ts'

/** Model tiers a run may use. */
export type MinerTier = 'main' | 'deep'

/** Spend cap of one rule miner call per tier, in USD. */
export const CALL_CAPS: Readonly<Record<MinerTier, number>> = { main: 0.4, deep: 1 }

/**
 * Reference prices per million tokens the estimate uses, per tier: a Sonnet-class model on
 * `main`, an Opus-class one on `deep`. The real cap is `CALL_CAPS`.
 */
export const REFERENCE_PRICES: Readonly<Record<MinerTier, { input: number; output: number }>> = {
  main: { input: 3, output: 15 },
  deep: { input: 5, output: 25 },
}

/** Output tokens the estimate counts per requested rule. */
export const OUTPUT_TOKENS_PER_RULE = 150

/** Expected cost of one call over a prompt of `promptChars`, at four characters per token. */
export function estimateMinerCost(
  promptChars: number,
  tier: MinerTier,
  maxRules = 10,
): { inputTokens: number; outputTokens: number; usd: number } {
  const inputTokens = Math.ceil((promptChars + MINER_SYSTEM.length) / 4)
  const outputTokens = maxRules * OUTPUT_TOKENS_PER_RULE
  const price = REFERENCE_PRICES[tier]
  const usd = (inputTokens * price.input + outputTokens * price.output) / 1_000_000
  return { inputTokens, outputTokens, usd: Math.round(usd * 10_000) / 10_000 }
}

/** A rule the model extracted, with the comments that support it. */
export interface MinedRule {
  text: string
  reason?: string
  comments: ReviewComment[]
  /** Distinct merge requests among `comments`; the recurrence weight. */
  mergeRequests: number
}

/** A rule the post-check left out, with why. */
export interface DroppedRule {
  text: string
  reason: string
}

const NAME_MIN = 3

/**
 * The deterministic check of the model's answer: comment ids the prompt did not list are ignored
 * and a rule left with none is dropped, so is a rule naming a comment's author; rules with the
 * same `learningKey` are merged. The rest is ordered by recurrence: distinct merge requests, then
 * comments, then the model's order. Nothing is capped here.
 */
export function acceptRules(
  output: MinerOutput,
  comments: readonly ReviewComment[],
): { rules: MinedRule[]; dropped: DroppedRule[] } {
  const byId = new Map(comments.map((comment) => [comment.id, comment]))
  const authors = [
    ...new Set(
      comments
        .map((comment) => comment.source.author?.toLowerCase())
        .filter((name): name is string => name !== undefined && name.length >= NAME_MIN),
    ),
  ]
  const byKey = new Map<string, MinedRule & { order: number }>()
  const dropped: DroppedRule[] = []
  for (const [order, answer] of output.rules.entries()) {
    const text = answer.text.replaceAll(/\s+/g, ' ').trim()
    const cited = [...new Set(answer.comments.map((id) => id.trim()))]
      .map((id) => byId.get(id))
      .filter((comment): comment is ReviewComment => comment !== undefined)
    if (!cited.length) {
      dropped.push({ text, reason: 'cites no known comment' })
      continue
    }
    const lower = text.toLowerCase()
    if (authors.some((name) => lower.includes(name))) {
      dropped.push({ text, reason: 'names a person' })
      continue
    }
    const key = learningKey(text)
    const same = byKey.get(key)
    if (same) {
      for (const comment of cited) if (!same.comments.includes(comment)) same.comments.push(comment)
      continue
    }
    byKey.set(key, {
      text,
      ...(answer.reason && { reason: answer.reason }),
      comments: cited,
      mergeRequests: 0,
      order,
    })
  }
  for (const rule of byKey.values())
    rule.mergeRequests = new Set(rule.comments.map((comment) => comment.mergeRequest.id)).size
  const rules = [...byKey.values()]
    .toSorted(
      (a, b) =>
        b.mergeRequests - a.mergeRequests ||
        b.comments.length - a.comments.length ||
        a.order - b.order,
    )
    .map(({ order: _order, ...rule }) => rule)
  return { rules, dropped }
}

/** What one mining call needs. */
export interface MineRulesInput {
  agent: Agent
  /** Directory the agent runs in; it gets no tools. */
  dir: string
  prompt: MinerPromptInput
  tier: MinerTier
  signal?: AbortSignal
  log?: (line: string) => void
}

/** The call a run made. */
export interface MinerCall {
  tier: MinerTier
  model: string
  costUsd: number
  estimateUsd: number
}

/**
 * One agent call that turns review comments into rules, checked by `acceptRules`. The call gets
 * no tools, at most two turns, the cap of its tier (`CALL_CAPS`), `taskKind: 'rule-miner'` and the
 * estimate (`estimateMinerCost`) for the budget check, logged before it starts. A
 * `BudgetExceededError` (the weekly budget refused the run or the cap was reached) propagates.
 */
export async function mineRules(
  input: MineRulesInput,
): Promise<{ rules: MinedRule[]; dropped: DroppedRule[]; call: MinerCall }> {
  const prompt = minerPrompt(input.prompt)
  const estimate = estimateMinerCost(prompt.length, input.tier, input.prompt.maxRules)
  input.log?.(
    `budget: estimate $${estimate.usd.toFixed(2)}, cap $${CALL_CAPS[input.tier].toFixed(2)} (tier ${input.tier}, ~${Math.round(estimate.inputTokens / 1000)}k input tokens)`,
  )
  const answer = await input.agent.run({
    dir: input.dir,
    system: MINER_SYSTEM,
    context: MINER_CONTEXT,
    prompt,
    capabilities: [],
    output: minerOutput,
    maxTurns: 2,
    tier: input.tier,
    maxCostUsd: CALL_CAPS[input.tier],
    estimateUsd: estimate.usd,
    taskKind: 'rule-miner',
    ...(input.signal && { signal: input.signal }),
  })
  return {
    ...acceptRules(answer.output ?? { rules: [] }, input.prompt.comments),
    call: {
      tier: input.tier,
      model: answer.model ?? `tier:${input.tier}`,
      costUsd: answer.costUsd ?? 0,
      estimateUsd: estimate.usd,
    },
  }
}
