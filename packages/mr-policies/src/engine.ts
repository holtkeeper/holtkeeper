import { scopeCoversRepo, scopeSpecificity } from '@holtkeeper/access'
import type { GitForge } from '@holtkeeper/forge'

import { builtinActions } from './actions/index.ts'
import {
  type ActionContext,
  type ActionRegistry,
  type ActionResult,
  createRegistry,
} from './actions/provider.ts'
import { evaluateCondition } from './conditions.ts'
import { createFacts } from './facts.ts'
import { createMemory } from './memory.ts'
import {
  type ActionOutcome,
  type EnqueueIntent,
  type MergeRequestEvent,
  type Policy,
  type PolicyMemory,
  eventRepo,
} from './model.ts'

/** Input of `evaluatePolicies`. */
export interface EvaluatePoliciesInput {
  policies: readonly Policy[]
  event: MergeRequestEvent
  forge: GitForge
  now?: Date
  /** Evaluate and report what would happen without changing anything or remembering actions. */
  dryRun?: boolean
  /** Action providers; the built-ins when omitted. */
  registry?: ActionRegistry
  /** Where done actions are remembered; a process-wide in-memory default when omitted. */
  memory?: PolicyMemory
  /** The username Holtkeeper acts as; it never approves its own merge requests by default. */
  botUser?: string
  /** Usernames or globs of bot users, for `author.bot` conditions. */
  bots?: string[]
  /** Used by the `webhook` action; global `fetch` when omitted. */
  fetch?: ActionContext['fetch']
}

/** What the policies decided for one event. */
export interface PolicyEvaluation {
  /** Matched policies in evaluation order, with the reasons their conditions held. */
  matched: { policyId: string; reasons: string[] }[]
  /** Policies that were considered but did not apply, with the first reason why. */
  unmatched: { policyId: string; reason: string }[]
  /** One outcome per action of the matched policies, in order. */
  outcomes: ActionOutcome[]
  /** Analyzers the caller should not enqueue for this event; `*` for all. */
  skipAnalyzers: '*' | string[]
  /** Analyzers the caller should enqueue, deduplicated; not filtered by `skipAnalyzers`. */
  enqueue: EnqueueIntent[]
}

const defaultMemory = createMemory()

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Policies that apply to the repository, most specific scope first and in list order among
 * equally specific ones. Disabled policies are left out.
 */
export function orderPolicies(policies: readonly Policy[], event: MergeRequestEvent): Policy[] {
  const repo = eventRepo(event)
  return policies
    .filter(
      (policy) =>
        policy.enabled &&
        scopeCoversRepo(policy.scope, repo) &&
        (!policy.within || scopeCoversRepo(policy.within, repo)),
    )
    .toSorted((a, b) => scopeSpecificity(b.scope) - scopeSpecificity(a.scope))
}

function mergeSkips(current: '*' | string[], next: Policy['skipAnalyzers']): '*' | string[] {
  if (current === '*' || next === '*') return '*'
  return next ? [...new Set([...current, ...next])] : current
}

/**
 * Evaluates merge request policies for one event and runs the actions of those that match.
 * Deterministic: policies run in `orderPolicies` order, actions in list order, and a matching
 * policy with `stop` ends evaluation. Actions with a once-key (approve, merge, comment) that
 * already happened for the same head commit are skipped. The engine never enqueues jobs; it
 * returns `skipAnalyzers` and `enqueue` for the caller.
 */
export async function evaluatePolicies(input: EvaluatePoliciesInput): Promise<PolicyEvaluation> {
  const { forge, botUser, bots } = input
  const registry = input.registry ?? createRegistry(builtinActions)
  const memory = input.memory ?? defaultMemory
  const now = input.now ?? new Date()
  const dryRun = input.dryRun ?? false
  const doFetch = input.fetch ?? ((url, init) => fetch(url, init))
  const event: MergeRequestEvent = {
    ...input.event,
    mr: { ...input.event.mr, labels: [...input.event.mr.labels] },
  }
  const facts = createFacts(forge, event)
  const repo = eventRepo(event)

  const result: PolicyEvaluation = {
    matched: [],
    unmatched: [],
    outcomes: [],
    skipAnalyzers: [],
    enqueue: [],
  }
  const considered = new Set<string>()
  for (const policy of input.policies) {
    if (!policy.enabled) result.unmatched.push({ policyId: policy.id, reason: 'disabled' })
  }

  for (const policy of orderPolicies(input.policies, event)) {
    considered.add(policy.id)
    let reasons: string[]
    try {
      const condition = await evaluateCondition(policy.when, { event, facts, bots })
      if (!condition.ok) {
        result.unmatched.push({ policyId: policy.id, reason: condition.reasons.join('; ') })
        continue
      }
      reasons = condition.reasons
    } catch (error) {
      result.unmatched.push({ policyId: policy.id, reason: `error: ${errorMessage(error)}` })
      continue
    }
    result.matched.push({ policyId: policy.id, reasons })
    result.skipAnalyzers = mergeSkips(result.skipAnalyzers, policy.skipAnalyzers)

    const context: ActionContext = {
      event,
      policy,
      forge,
      facts,
      now,
      dryRun,
      botUser,
      scopeCovers:
        scopeCoversRepo(policy.scope, repo) &&
        (!policy.within || scopeCoversRepo(policy.within, repo)),
      fetch: doFetch,
      async perform(detail, effect, data) {
        if (dryRun) return { status: 'dry-run', detail: `would be ${detail}`, data }
        try {
          await effect()
          return { status: 'done', detail, data }
        } catch (error) {
          return { status: 'failed', detail: `${detail} failed: ${errorMessage(error)}`, data }
        }
      },
    }

    for (const action of policy.actions) {
      const provider = registry.get(action.type)
      const record = (outcome: ActionResult) => {
        result.outcomes.push({
          policyId: policy.id,
          action: action.type,
          status: outcome.status,
          detail: outcome.detail,
          ...(outcome.data ? { data: outcome.data } : {}),
        })
        for (const intent of outcome.enqueue ?? []) {
          const same = (other: EnqueueIntent) =>
            other.analyzer === intent.analyzer &&
            JSON.stringify(other.options) === JSON.stringify(intent.options)
          if (!result.enqueue.some(same)) result.enqueue.push(intent)
        }
      }
      if (!provider) {
        record({ status: 'failed', detail: `unknown action ${action.type}` })
        continue
      }
      try {
        const key = await provider.onceKey?.(action, context)
        if (key && (await memory.seen(key))) {
          record({ status: 'skipped', detail: 'already done earlier, not repeated' })
          continue
        }
        const outcome = await provider.run(action, context)
        if (key && outcome.status === 'done' && !dryRun) await memory.remember(key)
        record(outcome)
      } catch (error) {
        record({ status: 'failed', detail: errorMessage(error) })
      }
    }
    if (policy.stop) break
  }

  for (const policy of input.policies) {
    if (
      policy.enabled &&
      !considered.has(policy.id) &&
      !result.unmatched.some((u) => u.policyId === policy.id)
    ) {
      const covered = orderPolicies([policy], event).length > 0
      result.unmatched.push({
        policyId: policy.id,
        reason: covered
          ? 'an earlier policy stopped evaluation'
          : 'scope does not cover the repository',
      })
    }
  }
  return result
}
