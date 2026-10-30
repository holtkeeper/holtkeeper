import type { RepoTarget } from '@holtkeeper/access'
import { scopeCoversRepo } from '@holtkeeper/access'
import {
  type Agent,
  type AgentResult,
  type AgentTask,
  type ConcurrencyLimiter,
  type AiProvider,
  type CreateAgentOptions,
  type ModelCatalog,
  type ProviderAgent,
  type Toolset,
  createAgent,
  createLimiter,
  isAiProviderKind,
  modelCatalog,
  parseProviderOptions,
  resolveProviderRouting,
} from '@holtkeeper/agent'
import {
  type AgentToolSettings,
  type Context7Options,
  codeTools,
  docsTools,
  externalServers,
  knowledgeTools,
} from '@holtkeeper/agent-tools'
import {
  BudgetExceededError,
  type BudgetGuard,
  budgetGuard,
  usageRecorder,
} from '@holtkeeper/ai-usage'
import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { CommandRunner } from '@holtkeeper/exec'
import type { RepoRef } from '@holtkeeper/forge'
import { knowledgeAccess, selectForTask } from '@holtkeeper/knowledge'
import { type Limiter, limitAgent, limitPolicySchema, resolveLimitPolicy } from '@holtkeeper/limits'
import { resolveSetting } from '@holtkeeper/settings'
import type { SettingEntry, Store, StoredCredential } from '@holtkeeper/store'
import type { Vault } from '@holtkeeper/vault'
import { z } from 'zod'

import { repoTarget } from './context.ts'

/** Tokens of team knowledge put into a task's context when `agent.tools.knowledgeTokens` is unset. */
export const DEFAULT_KNOWLEDGE_TOKENS = 1500

/** `taskKind` used for knowledge and reporting when a task sets none. */
const DEFAULT_TASK_KIND = 'agent'

/** `agent.tools` as the server reads it. */
interface ServerToolSettings extends AgentToolSettings {
  knowledgeTokens?: number
}

/** Who and what runs of a wrapped agent are for, beyond the repository. */
interface AgentRunOrigin {
  actor?: string
  analyzer?: string
  jobId?: string
}

/** One finished (or budget-denied) agent run. Exactly one of `result` and `error` is set. */
export interface AgentRunInfo extends AgentRunOrigin {
  repo: RepoTarget
  taskKind: string
  /** The provider credential's name. */
  provider: string
  /** Provider kind, e.g. `anthropic-compatible`. */
  providerKind: string
  /** The provider's model name the task ran on. */
  model: string
  result?: AgentResult
  error?: unknown
  durationMs: number
  /** When the run started. */
  at: string
}

/** Called after every run of a wrapped agent; its errors never change the run's outcome. */
type OnAgentRun = (info: AgentRunInfo) => void | Promise<void>

export interface ServerDefaultsOptions {
  repo: RepoTarget
  store: Pick<Store, 'knowledge'> & Partial<Pick<Store, 'activity'>>
  now: () => Date
  /** Provider label for `onRun`; default the provider kind. */
  provider?: string
  origin?: AgentRunOrigin
  /** Runs `go list`/`go doc` for `docs.package`; the job's runner when there is one. */
  runner?: CommandRunner
  tools?: ServerToolSettings
  context7?: Context7Options
  /** Checked before every run; a denial throws `BudgetExceededError` (and is reported to `onRun`). */
  budgets?: Pick<BudgetGuard, 'check'>
  onRun?: OnAgentRun
  /** Receives errors thrown by `onRun`. */
  onRunError?: (error: unknown) => void
}

const merge = (ours: Toolset[], theirs: readonly Toolset[] = []): Toolset[] => {
  const names = new Set(theirs.map((toolset) => toolset.name))
  return [...ours.filter((toolset) => !names.has(toolset.name)), ...theirs]
}

/**
 * `agent` with what every server task gets: the `code`, `docs` and `knowledge` toolsets (a
 * toolset of the same name in the task wins), accepted knowledge for the repository and task kind
 * (within `tools.knowledgeTokens`, default `DEFAULT_KNOWLEDGE_TOKENS`) placed before the task's
 * own `context`, and the external MCP servers `tools` enables (Context7 only with
 * `context7: true`; the task's servers win). `budgets` may deny a run before it starts. `onRun`
 * hears about every run: successful, failed or denied.
 */
export function withServerDefaults(
  agent: Agent | ProviderAgent,
  options: ServerDefaultsOptions,
): Agent {
  const { repo, store, now, tools = {} } = options
  const access = knowledgeAccess({ store, now })
  const budget = tools.maxResultLines !== undefined ? { maxResultLines: tools.maxResultLines } : {}
  const budgetTokens = tools.knowledgeTokens ?? DEFAULT_KNOWLEDGE_TOKENS
  const providerKind = 'provider' in agent ? agent.provider : agent.name
  const provider = options.provider ?? providerKind
  const modelOf = (taskKind: string) => ('modelFor' in agent ? agent.modelFor(taskKind) : '')
  const onRunError = options.onRunError ?? ((error: unknown) => console.error(error))

  return {
    name: agent.name,
    async run<Output>(task: AgentTask<Output>): Promise<AgentResult<Output>> {
      const taskKind = task.taskKind ?? DEFAULT_TASK_KIND
      const started = now()
      const report = async (outcome: { result: AgentResult } | { error: unknown }) => {
        try {
          await options.onRun?.({
            ...options.origin,
            repo,
            taskKind,
            provider,
            providerKind,
            model: modelOf(taskKind),
            ...outcome,
            durationMs: Math.max(0, now().getTime() - started.getTime()),
            at: started.toISOString(),
          })
        } catch (error) {
          onRunError(error)
        }
      }
      if (options.budgets) {
        const decision = await options.budgets.check({ repo, taskKind })
        if (!decision.allowed) {
          const error = new BudgetExceededError(decision.exceeded)
          await report({ error })
          throw error
        }
      }
      try {
        const knowledge =
          budgetTokens > 0
            ? selectForTask({
                entries: await store.knowledge.list({ status: 'accepted' }),
                task: { kind: taskKind, repo },
                budgetTokens,
              }).markdown.trim()
            : ''
        const context = [knowledge, task.context?.trim() ?? ''].filter(Boolean).join('\n\n')
        const toolsets = merge(
          [
            codeTools({ budget }),
            docsTools({ budget, ...(options.runner && { runner: options.runner }) }),
            knowledgeTools({ access, repo, taskKind, actor: `agent:${taskKind}`, budget }),
          ],
          task.toolsets,
        )
        const mcpServers = { ...externalServers(tools, options.context7), ...task.mcpServers }
        const result = await agent.run({
          ...task,
          taskKind,
          toolsets,
          ...(context && { context }),
          ...(Object.keys(mcpServers).length > 0 && { mcpServers }),
        })
        await report({ result })
        return result
      } catch (error) {
        await report({ error })
        throw error
      }
    },
  }
}

const stringSetting = (entries: SettingEntry[], key: string, target: RepoTarget) => {
  const entry = resolveSetting(entries, key, target)
  return entry && !entry.secret && typeof entry.value === 'string' ? entry.value : undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((item) => typeof item === 'string')

/**
 * The AI provider credential `llm.provider` names (by id first, then by name) among the
 * credentials whose scope covers the repository and whose kind is an AI provider kind.
 */
export function findProviderCredential(
  credentials: readonly StoredCredential[],
  reference: string,
  repo: RepoTarget,
): StoredCredential | undefined {
  const usable = credentials.filter(
    (credential) => isAiProviderKind(credential.kind) && scopeCoversRepo(credential.scope, repo),
  )
  return (
    usable.find((credential) => credential.id === reference) ??
    usable.find((credential) => credential.name === reference)
  )
}

export interface SettingsAgentOptions {
  config: HoltkeeperConfig
  store: Store
  vault: Vault
  now?: () => Date
  /** Runs commands for docs lookups and the OpenAI-compatible `run_command` when a job gives none. */
  runner?: CommandRunner
  context7?: Context7Options
  /**
   * Hears about every run. Default: `usageRecorder(store.aiUsage)`, which records usage in the
   * store (and keeps the default budget guard's cached spend current).
   */
  onRun?: OnAgentRun
  /** Budget guard checked before every run. Default: `budgetGuard` over the `llm.budget` settings; `false` disables it. */
  budgets?: BudgetGuard | false
  log?: (line: string) => void
  /** Test seams of `createAgent`. */
  agentOptions?: Pick<CreateAgentOptions, 'query' | 'fetch' | 'maxTurns'>
  /**
   * Shared per-credential limits (concurrency, tokens per minute, daily caps). Every job using the
   * same provider credential draws from one budget, so parallel jobs cannot exhaust a key together.
   */
  rateLimiter?: Limiter
  /** Listings that `@latest` model references resolve against. Default: `modelCatalog()`. */
  models?: ModelCatalog
}

/** What a caller may tell `settingsAgentFor` about the job an agent is for. */
interface AgentJob extends AgentRunOrigin {
  /** The job's command runner, e.g. the container runner. */
  runner?: CommandRunner
}

/** `AgentFor` that may also receive the job's runner and identity. */
export type ServerAgentFor = (repo: RepoRef, job?: AgentJob) => Promise<Agent | undefined>

/**
 * The agent for a repository from scoped settings, wrapped with `withServerDefaults` (tools,
 * knowledge, budgets, usage recording). `llm.provider` names an AI provider credential (id or
 * name, scope covering the repository), opened with the vault. `llm.model` and `llm.models`
 * override the provider's models. Unset, no agent — analyzers then run without one; a named
 * provider that is missing or invalid is logged and also yields no agent. Runs of one provider
 * credential share its `maxConcurrency`.
 */
export function settingsAgentFor(options: SettingsAgentOptions): ServerAgentFor {
  const { config, store, vault } = options
  const now = options.now ?? (() => new Date())
  const log = options.log ?? (() => {})
  const limiters = new Map<string, ConcurrencyLimiter>()
  const catalog = options.models ?? modelCatalog()
  const routingFor = async (key: string, provider: AiProvider, routing: CreateAgentOptions) => ({
    ...routing,
    ...(await resolveProviderRouting(provider, routing, () => catalog.list(key, provider))),
  })
  const budgets =
    options.budgets === false
      ? undefined
      : (options.budgets ??
        budgetGuard({
          settings: store.settings,
          usage: store.aiUsage,
          activity: store.activity,
          now,
        }))
  const onRun: OnAgentRun =
    options.onRun ?? usageRecorder(store.aiUsage, { now, ...(budgets && { budgets }) })

  const limiterFor = (credential: StoredCredential): ConcurrencyLimiter | undefined => {
    const max = credential.options?.['maxConcurrency']
    if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) return undefined
    const existing = limiters.get(credential.id)
    if (existing?.max === max) return existing
    const limiter = createLimiter(max)
    limiters.set(credential.id, limiter)
    return limiter
  }

  return async (repo, job) => {
    const target = repoTarget(config, repo)
    const entries = await store.settings.list()
    const model = stringSetting(entries, 'llm.model', target)
    const models = resolveSetting(entries, 'llm.models', target)?.value
    const runner = job?.runner ?? options.runner
    const routing: CreateAgentOptions = {
      ...options.agentOptions,
      ...(model && { model }),
      ...(isStringRecord(models) && { models }),
      ...(runner && { runner }),
    }

    const reference = stringSetting(entries, 'llm.provider', target)
    if (!reference) return undefined
    const credential = findProviderCredential(await store.credentials.list(), reference, target)
    if (!credential) {
      log(`agent: no AI provider credential "${reference}" covers ${repo.forge}:${repo.path}`)
      return undefined
    }
    let agent: ProviderAgent
    try {
      parseProviderOptions(credential)
      const limiter = limiterFor(credential)
      const aiProvider: AiProvider = {
        kind: credential.kind,
        url: credential.url,
        secret: await vault.open(credential.secret),
        ...(credential.options && { options: credential.options }),
      }
      agent = createAgent(aiProvider, {
        ...(await routingFor(`${credential.id}:${credential.updatedAt}`, aiProvider, routing)),
        ...(limiter && { limiter }),
      })
    } catch (error) {
      log(
        `agent: provider "${credential.name}": ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
    const provider = credential.name
    const limited = { key: credential.id, credential }

    const tools = resolveSetting(entries, 'agent.tools', target)?.value
    const origin: AgentRunOrigin = {
      ...(job?.actor !== undefined && { actor: job.actor }),
      ...(job?.analyzer !== undefined && { analyzer: job.analyzer }),
      ...(job?.jobId !== undefined && { jobId: job.jobId }),
    }
    const wrapped = withServerDefaults(agent, {
      repo: target,
      store,
      now,
      provider,
      origin,
      onRun,
      ...(budgets && { budgets }),
      ...(runner && { runner }),
      ...(isRecord(tools) && { tools }),
      ...(options.context7 && { context7: options.context7 }),
      onRunError: (error) =>
        log(
          `agent: recording a run failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
    })
    if (!options.rateLimiter) return wrapped
    const configuredLimits = z
      .record(z.string(), limitPolicySchema)
      .safeParse(resolveSetting(entries, 'limits.credentials', target)?.value)
    return limitAgent(
      wrapped,
      options.rateLimiter,
      limited.key,
      resolveLimitPolicy(
        limited.credential,
        configuredLimits.success ? configuredLimits.data : undefined,
      ),
    )
  }
}
