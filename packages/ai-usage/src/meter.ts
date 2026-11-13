import type { RepoTarget } from '@holtkeeper/access'
import {
  type Agent,
  type AgentResult,
  type AgentTask,
  type AgentUsage,
  BudgetExceededError,
} from '@holtkeeper/agent'
import type { RepoRef } from '@holtkeeper/forge'
import type { AiUsageRecord, AiUsageStore } from '@holtkeeper/store'

import type { BudgetGuard, BudgetLimitStatus } from './budget.ts'
import { type ModelPrices, costOf, defaultPrices, emptyUsage } from './cost.ts'

/**
 * Thrown instead of running an agent when a `block` budget would be exceeded. A
 * `BudgetExceededError` from `@holtkeeper/agent` (and named so) that never used anything.
 */
export class BudgetDeniedError extends BudgetExceededError {
  readonly exceeded: BudgetLimitStatus[]
  constructor(exceeded: BudgetLimitStatus[]) {
    const blocking = exceeded.filter((status) => status.action === 'block')
    super(
      `AI budget exceeded: ${blocking
        .map(
          (s) =>
            `week of ${s.week} $${s.spentUsd.toFixed(2)} spent + $${s.estimateUsd.toFixed(2)} estimated over $${s.limitUsd.toFixed(2)}${s.interactive ? '' : ` (the last $${s.reserveUsd.toFixed(2)} of $${s.weeklyUsd.toFixed(2)} is kept for interactive work)`}`,
        )
        .join(', ')}`,
    )
    this.exceeded = exceeded
  }
}

/** Who and what a metered run is for. */
export interface MeteredContext {
  repo: RepoTarget
  /** Principal id, or `system` for unattended runs. */
  actor: string
  /** Credential id or name, or `anthropic`. */
  provider: string
  model: string
  /** Used when the task has no `taskKind`. Default `agent`. */
  taskKind?: string
  analyzer?: string
  jobId?: string
  analysisId?: string
  /** A person started the runs; see `BudgetCheck.interactive`. Default `false`. */
  interactive?: boolean
  /** What the runs work on, stored as `AiUsageRecord.subject`. */
  subject?: string
}

/** `task` with `maxCostUsd` lowered to `remainingUsd` when that is smaller. */
export function withCostCap<Output>(
  task: AgentTask<Output>,
  remainingUsd: number | undefined,
): AgentTask<Output> {
  if (remainingUsd === undefined) return task
  return { ...task, maxCostUsd: Math.min(task.maxCostUsd ?? Infinity, remainingUsd) }
}

export interface MeteredAgentOptions {
  /** Persists one usage record, e.g. `(entry) => store.aiUsage.append(entry)`. */
  record(entry: Omit<AiUsageRecord, 'id'>): unknown
  budgets?: BudgetGuard
  context: MeteredContext
  prices?: ModelPrices
  now?: () => Date
  /** Called when `record` fails; the run's own outcome is never replaced by it. Default `console.error`. */
  onRecordError?: (error: unknown) => void
}

const usageFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const

const isUsage = (value: unknown): value is AgentUsage =>
  typeof value === 'object' &&
  value !== null &&
  usageFields.every((field) => field in value && typeof Reflect.get(value, field) === 'number')

/** Token counts, cost and turns an error carries, when the agent attached them. */
export function partialUsage(error: unknown): Pick<AgentResult, 'usage' | 'costUsd' | 'turns'> {
  if (typeof error !== 'object' || error === null) return { turns: 0 }
  const usage = 'usage' in error ? error.usage : undefined
  const costUsd = 'costUsd' in error ? error.costUsd : undefined
  const turns = 'turns' in error ? error.turns : undefined
  return {
    turns: typeof turns === 'number' ? turns : 0,
    ...(isUsage(usage) && { usage }),
    ...(typeof costUsd === 'number' && { costUsd }),
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const budgetStop = (error: unknown) => error instanceof BudgetExceededError

/** Builds the record for a finished or failed run. */
export function usageEntry(
  base: {
    at: string
    repo: RepoRef
    groups: string[]
    taskKind: string
    actor: string
    provider: string
    model: string
    interactive?: boolean
    subject?: string
    analyzer?: string
    jobId?: string
    analysisId?: string
    transcriptRef?: string
    durationMs: number
  },
  outcome: { result: Pick<AgentResult, 'usage' | 'costUsd' | 'turns'> } | { error: unknown },
  prices: ModelPrices = defaultPrices,
): Omit<AiUsageRecord, 'id'> {
  const result = 'result' in outcome ? outcome.result : partialUsage(outcome.error)
  const usage = result.usage ?? emptyUsage()
  return {
    at: base.at,
    repo: { forge: base.repo.forge, path: base.repo.path },
    groups: base.groups,
    taskKind: base.taskKind,
    ...(base.analyzer !== undefined && { analyzer: base.analyzer }),
    ...(base.jobId !== undefined && { jobId: base.jobId }),
    ...(base.analysisId !== undefined && { analysisId: base.analysisId }),
    actor: base.actor,
    interactive: base.interactive ?? false,
    ...(base.subject !== undefined && { subject: base.subject }),
    provider: base.provider,
    model: base.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    ...costOf(result, base.model, prices),
    durationMs: base.durationMs,
    turns: result.turns,
    outcome: 'result' in outcome ? 'ok' : budgetStop(outcome.error) ? 'denied-budget' : 'error',
    ...('error' in outcome && { error: message(outcome.error) }),
    ...(base.transcriptRef !== undefined && { transcriptRef: base.transcriptRef }),
  }
}

/**
 * Wraps an agent so every run is checked against budgets (with the task's `estimateUsd` when it
 * gives one) and recorded. A run a `block` budget
 * denies is recorded as `denied-budget` and throws `BudgetDeniedError` without calling the
 * agent; an allowed run is capped at the budget's remaining USD (`maxCostUsd`). Finished runs
 * are recorded as `ok`, failed ones as `error` with whatever usage the error carries; the
 * original result or error is passed through unchanged.
 */
export function meteredAgent(agent: Agent, options: MeteredAgentOptions): Agent {
  const { context, budgets, prices = defaultPrices, now = () => new Date() } = options
  const onRecordError = options.onRecordError ?? ((error: unknown) => console.error(error))

  const save = async (entry: Omit<AiUsageRecord, 'id'>) => {
    try {
      await options.record(entry)
      budgets?.note(entry)
    } catch (error) {
      onRecordError(error)
    }
  }

  return {
    name: agent.name,
    async run<Output>(task: AgentTask<Output>): Promise<AgentResult<Output>> {
      const taskKind = task.taskKind ?? context.taskKind ?? 'agent'
      const started = now()
      const base = {
        at: started.toISOString(),
        repo: context.repo,
        groups: context.repo.groups,
        taskKind,
        actor: context.actor,
        provider: context.provider,
        model: context.model,
        interactive: context.interactive ?? false,
        ...(context.subject !== undefined && { subject: context.subject }),
        ...(context.analyzer !== undefined && { analyzer: context.analyzer }),
        ...(context.jobId !== undefined && { jobId: context.jobId }),
        ...(context.analysisId !== undefined && { analysisId: context.analysisId }),
      }
      let capped = task
      if (budgets) {
        const decision = await budgets.check({
          repo: context.repo,
          taskKind,
          ...(context.interactive !== undefined && { interactive: context.interactive }),
          ...(task.estimateUsd !== undefined && { estimateUsd: task.estimateUsd }),
        })
        if (!decision.allowed) {
          const error = new BudgetDeniedError(decision.exceeded)
          await save(usageEntry({ ...base, durationMs: 0 }, { error }, prices))
          throw error
        }
        capped = withCostCap(task, decision.remainingUsd)
      }
      const elapsed = () => Math.max(0, now().getTime() - started.getTime())
      let result: AgentResult<Output>
      try {
        result = await agent.run(capped)
      } catch (error) {
        await save(usageEntry({ ...base, durationMs: elapsed() }, { error }, prices))
        throw error
      }
      await save(usageEntry({ ...base, durationMs: elapsed() }, { result }, prices))
      return result
    },
  }
}

/** What an agent wrapper reports after each run; `result` or `error` is set. */
export interface AgentRunInfo {
  repo: RepoRef & { groups?: string[] }
  taskKind: string
  provider: string
  model: string
  result?: Pick<AgentResult, 'usage' | 'costUsd' | 'turns'>
  error?: unknown
  durationMs: number
  /** Default `system`. */
  actor?: string
  /** A person started the run; see `BudgetCheck.interactive`. Default `false`. */
  interactive?: boolean
  /** What the run worked on, stored as `AiUsageRecord.subject`. */
  subject?: string
  analyzer?: string
  jobId?: string
  analysisId?: string
  /** When the run started; default now minus `durationMs`. */
  at?: string
  /** Artifact id of the run's transcript; stored on the record. */
  transcriptRef?: string
}

export interface UsageRecorderOptions {
  prices?: ModelPrices
  now?: () => Date
  /** Groups of a repository when the info does not carry them; default none. */
  groupsOf?: (repo: RepoRef) => string[]
  /** Told about recorded runs so cached spend stays current. */
  budgets?: Pick<BudgetGuard, 'note'>
}

/**
 * An `onRun` hook that stores every reported run in `store`. A `BudgetExceededError` is stored as
 * `denied-budget`, with whatever usage it carries.
 */
export function usageRecorder(
  store: Pick<AiUsageStore, 'append'>,
  { prices = defaultPrices, now = () => new Date(), groupsOf, budgets }: UsageRecorderOptions = {},
): (info: AgentRunInfo) => Promise<void> {
  return async (info) => {
    const at = info.at ?? new Date(now().getTime() - info.durationMs).toISOString()
    const base = {
      at,
      repo: info.repo,
      groups: info.repo.groups ?? groupsOf?.(info.repo) ?? [],
      taskKind: info.taskKind,
      actor: info.actor ?? 'system',
      provider: info.provider,
      model: info.model,
      interactive: info.interactive ?? false,
      ...(info.subject !== undefined && { subject: info.subject }),
      ...(info.analyzer !== undefined && { analyzer: info.analyzer }),
      ...(info.jobId !== undefined && { jobId: info.jobId }),
      ...(info.analysisId !== undefined && { analysisId: info.analysisId }),
      ...(info.transcriptRef !== undefined && { transcriptRef: info.transcriptRef }),
      durationMs: info.durationMs,
    }
    const entry = info.result
      ? usageEntry(base, { result: info.result }, prices)
      : usageEntry(base, { error: info.error }, prices)
    await store.append(entry)
    budgets?.note(entry)
  }
}
