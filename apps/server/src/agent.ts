import { type Principal, type RepoTarget, can, scopeCoversRepo } from '@holtkeeper/access'
import {
  type Agent,
  type AgentResult,
  type AgentTask,
  type ConcurrencyLimiter,
  type AiCatalog,
  type AiProviderPlugin,
  type AiProvider,
  type CreateAgentOptions,
  type ModelCatalog,
  type ModelListing,
  type ModelPricing,
  type ProviderAgent,
  type Toolset,
  createAgent,
  createLimiter,
  createTranscript,
  isAiProviderKind,
  modelCatalog,
  parseProviderOptions,
  resolveTierModels,
} from '@holtkeeper/agent'
import {
  type LibraryDocsAccess,
  RESULT_CAPS,
  capToolsets,
  codeTools,
  docsTools,
  knowledgeTools,
  libraryTools,
  mountToolsets,
} from '@holtkeeper/agent-tools'
import {
  BudgetDeniedError,
  type BudgetGuard,
  budgetGuard,
  usageRecorder,
  withCostCap,
} from '@holtkeeper/ai-usage'
import type { ArtifactStore } from '@holtkeeper/artifacts'
import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { CredentialService } from '@holtkeeper/credentials'
import type { CommandRunner } from '@holtkeeper/exec'
import type { RepoRef } from '@holtkeeper/forge'
import { createGuideResolver, guideTaskOf } from '@holtkeeper/guide'
import { knowledgeAccess } from '@holtkeeper/knowledge'
import { type Limiter, limitAgent, limitPolicySchema, resolveLimitPolicy } from '@holtkeeper/limits'
import { resolveGlobalSetting, resolveSetting } from '@holtkeeper/settings'
import type { KnowledgeKind, SettingEntry, Store, StoredCredential } from '@holtkeeper/store'
import type { Vault } from '@holtkeeper/vault'
import { z } from 'zod'

import { createApiCatalog } from './api-surface/catalog.ts'
import { createUsageIndex } from './api-surface/usages.ts'
import { repoTarget } from './context.ts'
import {
  agentSummarize,
  githubClientFor,
  librariesConfigFrom,
  serverLibraryDocs,
} from './libraries.ts'
import { type AssetToolsAccess, assetsToolset, storedAssetTools } from './tools/assets.ts'
import { type CatalogToolsContext, catalogToolset } from './tools/catalog.ts'
import { type OpsToolsAccess, opsToolset } from './tools/ops.ts'
import { agentCatalogContext, agentRulesAccess, taskToolsets } from './tools/registry.ts'
import { type ReleaseToolsAccess, releasesToolset } from './tools/releases.ts'
import type { SupplyToolsAccess } from './tools/repos.ts'
import { type RulesAccess, rulesToolset, testIdsReader } from './tools/rules.ts'
import { stackToolset } from './tools/stack.ts'
import { storeTranscript } from './transcripts.ts'
import { crossTeamOf } from './visibility.ts'

/** Tokens of team knowledge a task's Guide may hold when `agent.tools.knowledgeTokens` is unset. */
export const DEFAULT_KNOWLEDGE_TOKENS = 1500

/** `taskKind` used for knowledge and reporting when a task sets none. */
const DEFAULT_TASK_KIND = 'agent'

/** `agent.tools` as the server reads it. */
interface ServerToolSettings {
  knowledgeTokens?: number
}

/** Who and what runs of a wrapped agent are for, beyond the repository. */
interface AgentRunOrigin {
  actor?: string
  analyzer?: string
  jobId?: string
  /**
   * A person started the work (a click in the panel, chat, a command), so it may spend the
   * budget reserve. Default `false`: automatic work.
   */
  interactive?: boolean
  /** What the runs work on (a merge request, a version, a task title), kept on usage records. */
  subject?: string
}

/** One finished (or budget-denied) agent run. Exactly one of `result` and `error` is set. */
export interface AgentRunInfo extends AgentRunOrigin {
  repo: RepoTarget
  taskKind: string
  /** The provider credential's name. */
  provider: string
  /** Provider kind, e.g. `anthropic-compatible`. */
  providerKind: string
  /** The provider's model name the task ran on (its tier's model). */
  model: string
  result?: AgentResult
  error?: unknown
  durationMs: number
  /** When the run started. */
  at: string
  /** Artifact id of the run's JSONL transcript, when it was stored. */
  transcriptRef?: string
}

/** Called after every run of a wrapped agent; its errors never change the run's outcome. */
type OnAgentRun = (info: AgentRunInfo) => void | Promise<void>

export interface ServerDefaultsOptions {
  repo: RepoTarget
  store: Pick<Store, 'knowledge' | 'guides' | 'families' | 'settings'> &
    Partial<Pick<Store, 'audit'>>
  now: () => Date
  /** Provider label for `onRun`; default the provider kind. */
  provider?: string
  origin?: AgentRunOrigin
  /** Runs `go list`/`go doc` for `docs.package`; the job's runner when there is one. */
  runner?: CommandRunner
  tools?: ServerToolSettings
  /** Knowledge kinds the agent's proposals are accepted for without review. */
  autoAccept?: readonly KnowledgeKind[]
  /** Third-party library docs; adds the `libraries` toolset with versions defaulting to `repo`'s. */
  libraries?: LibraryDocsAccess
  /** The organization's package catalog; adds the `catalog` toolset for task kinds that mount it. */
  catalog?: CatalogToolsContext
  /** Other repositories' rules and test ids; adds the `rules` toolset for task kinds that mount it. */
  rules?: RulesAccess
  /** Release state of the repository and its teammates; adds the read-only `releases` toolset for task kinds that mount it. */
  releases?: ReleaseToolsAccess
  /** Jobs, logs and budgets of the repository and its teammates; adds the read-only `ops` toolset for task kinds that mount it. */
  ops?: OpsToolsAccess
  /** Asset policies and assets records; adds the read-only `assets` toolset for task kinds that mount it. */
  assets?: AssetToolsAccess
  /**
   * The person the runs answer (team chat): knowledge tools are then search-only, and offered only
   * with their `knowledge:read` on `repo`.
   */
  requester?: Principal
  /**
   * Checked before every run with `origin.interactive`; a denial throws `BudgetDeniedError` (and
   * is reported to `onRun`), an allowed run is capped at the budget's remaining USD.
   */
  budgets?: Pick<BudgetGuard, 'check'>
  /** Where every run that reached the provider stores its JSONL transcript (`storeTranscript`). */
  artifacts?: Pick<ArtifactStore, 'put'>
  onRun?: OnAgentRun
  /** Receives errors thrown by `onRun`. */
  onRunError?: (error: unknown) => void
}

const merge = (ours: Toolset[], theirs: readonly Toolset[] = []): Toolset[] => {
  const names = new Set(theirs.map((toolset) => toolset.name))
  return [...ours.filter((toolset) => !names.has(toolset.name)), ...theirs]
}

/**
 * `agent` with what server tasks get: the toolsets `taskToolsets` names for the task kind out of
 * `code`, `docs`, `knowledge`, `libraries` (when `libraries` is given), `catalog` (when
 * `catalog` is given), `rules` (when `rules` is given), `releases` (when `releases` is given), `ops` (when `ops` is given) and `assets` (when `assets` is given), then the task's own toolsets (one of the same name wins); every tool result
 * stays within `RESULT_CAPS`. A task without its own `context` gets the repository's Guide for
 * its task kind as `context` (`@holtkeeper/guide`: team rules, policies, generated text, then
 * notes within `tools.knowledgeTokens`, default `DEFAULT_KNOWLEDGE_TOKENS`); a task that brings a
 * `context` (the review, which resolves the Guide with the repository's rules files) keeps it as
 * is. No external MCP server is added. `budgets` may deny a run before it starts and caps the cost of the runs it allows
 * (`maxCostUsd`). With `artifacts`, every run that reached the provider stores its JSONL
 * transcript there and reports it as `transcriptRef` (on the result and to `onRun`); a failing
 * store is reported to `onRunError` and never fails the run. `onRun` hears about every run:
 * successful, failed or denied.
 */
export function withServerDefaults(
  agent: Agent | ProviderAgent,
  options: ServerDefaultsOptions,
): Agent {
  const { repo, store, now, tools = {} } = options
  const access = knowledgeAccess({
    store,
    now,
    ...(options.autoAccept && { autoAccept: options.autoAccept }),
  })
  const budgetTokens = tools.knowledgeTokens ?? DEFAULT_KNOWLEDGE_TOKENS
  const resolveGuide = createGuideResolver({ store })
  const providerKind = 'provider' in agent ? agent.provider : agent.name
  const provider = options.provider ?? providerKind
  const modelOf = (task: AgentTask) => ('modelFor' in agent ? agent.modelFor(task.tier) : '')
  const onRunError = options.onRunError ?? ((error: unknown) => console.error(error))
  const rules = options.rules && rulesToolset(options.rules)
  const { requester } = options
  const knowledgeOf = (taskKind: string): Toolset[] => {
    const knowledge = knowledgeTools({ access, repo, taskKind, actor: `agent:${taskKind}` })
    if (!requester) return [knowledge]
    if (!can(requester, 'knowledge:read', { kind: 'repo', repo })) return []
    return [
      { ...knowledge, tools: knowledge.tools.filter((tool) => tool.name === 'knowledge.search') },
    ]
  }

  return {
    name: agent.name,
    async run<Output>(task: AgentTask<Output>): Promise<AgentResult<Output>> {
      const taskKind = task.taskKind ?? DEFAULT_TASK_KIND
      const started = now()
      const transcript = options.artifacts ? createTranscript({ now }) : undefined
      const saveTranscript = async () => {
        if (!transcript || !options.artifacts) return undefined
        try {
          return await storeTranscript(options.artifacts, transcript, {
            repo: `${repo.forge}:${repo.path}`,
            taskKind,
            ...(options.origin?.jobId !== undefined && { job: options.origin.jobId }),
          })
        } catch (error) {
          onRunError(error)
          return undefined
        }
      }
      const report = async (
        outcome: { result: AgentResult } | { error: unknown },
        transcriptRef?: string,
      ) => {
        try {
          await options.onRun?.({
            ...options.origin,
            repo,
            taskKind,
            provider,
            providerKind,
            model: modelOf(task),
            ...outcome,
            durationMs: Math.max(0, now().getTime() - started.getTime()),
            at: started.toISOString(),
            ...(transcriptRef !== undefined && { transcriptRef }),
          })
        } catch (error) {
          onRunError(error)
        }
      }
      let capped: AgentTask<Output> = task
      if (options.budgets) {
        const decision = await options.budgets.check({
          repo,
          taskKind,
          interactive: options.origin?.interactive ?? false,
        })
        if (!decision.allowed) {
          const error = new BudgetDeniedError(decision.exceeded)
          await report({ error })
          throw error
        }
        capped = withCostCap(task, decision.remainingUsd)
      }
      let prepared: AgentTask<Output>
      try {
        const own = task.context?.trim()
        const context =
          own ||
          (
            await resolveGuide({
              repo,
              ...guideTaskOf(taskKind),
              taskKind,
              notesChars: budgetTokens * 4,
            })
          ).text
        const available = [
          codeTools({ budget: { maxHits: RESULT_CAPS.maxSnippets } }),
          docsTools(options.runner ? { runner: options.runner } : {}),
          ...knowledgeOf(taskKind),
          ...(options.libraries
            ? [libraryTools({ access: options.libraries, repo: `${repo.forge}:${repo.path}` })]
            : []),
          ...(options.catalog ? [catalogToolset(options.catalog)] : []),
          ...(options.catalog?.stack ? [stackToolset(options.catalog.stack)] : []),
          ...(rules ? [rules] : []),
          ...(options.releases ? [releasesToolset(options.releases)] : []),
          ...(options.ops ? [opsToolset(options.ops, now)] : []),
          ...(options.assets ? [assetsToolset(options.assets)] : []),
        ]
        const toolsets = capToolsets(
          merge(mountToolsets(available, taskToolsets(taskKind)), task.toolsets),
        )
        prepared = {
          ...capped,
          taskKind,
          toolsets,
          ...(context && { context }),
          ...(transcript && { transcript }),
        }
      } catch (error) {
        await report({ error })
        throw error
      }
      try {
        const result = await agent.run(prepared)
        const transcriptRef = await saveTranscript()
        const stored = transcriptRef === undefined ? result : { ...result, transcriptRef }
        await report({ result: stored }, transcriptRef)
        return stored
      } catch (error) {
        const transcriptRef = transcript?.lines().length ? await saveTranscript() : undefined
        await report({ error }, transcriptRef)
        throw error
      }
    },
  }
}

const knowledgeKindSchema = z.array(
  z.enum(['decision', 'convention', 'migration', 'quirk', 'howto'] satisfies KnowledgeKind[]),
)

/** `knowledge.autoAccept` for a repository; empty when unset or invalid. */
export function autoAcceptFrom(
  entries: readonly SettingEntry[],
  repo: RepoTarget,
): KnowledgeKind[] {
  const parsed = knowledgeKindSchema.safeParse(
    resolveSetting(entries, 'knowledge.autoAccept', repo)?.value,
  )
  return parsed.success ? parsed.data : []
}

/** The credential reference of the global `llm.provider` setting; narrower entries are ignored. */
export function providerReference(entries: readonly SettingEntry[]): string | undefined {
  const entry = resolveGlobalSetting(entries, 'llm.provider')
  return entry && !entry.secret && typeof entry.value === 'string' ? entry.value : undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

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
  /** Records each use of a provider or GitHub credential the agent opens. */
  credentials?: Pick<CredentialService, 'markUsed'>
  now?: () => Date
  /** Runs commands for docs lookups and the AI SDK `run_command` when a job gives none. */
  runner?: CommandRunner
  /**
   * Where the library index keeps API surfaces and source snapshots (with `store.libraries`,
   * agents get the `libraries` toolset) and where every run stores its transcript.
   */
  artifacts?: ArtifactStore
  /**
   * Read-only release tools for an agent working on a repository, narrowed to `requester` when a
   * person asked; without it agents get no `releases` toolset.
   */
  releases?: (repo: RepoTarget, requester?: Principal) => ReleaseToolsAccess | undefined
  /**
   * Read-only job and budget tools for an agent working on a repository, narrowed to `requester`
   * when a person asked; without it agents get no `ops` toolset.
   */
  ops?: (repo: RepoTarget, requester?: Principal) => OpsToolsAccess | undefined
  /** Findings and licenses for the person who asked; without it chat gets no supply tools. */
  supply?: (principal: Principal) => SupplyToolsAccess
  /**
   * Hears about every run. Default: `usageRecorder(store.aiUsage)`, which records usage in the
   * store (and keeps the default budget guard's cached spend current).
   */
  onRun?: OnAgentRun
  /**
   * Budget guard checked before every run. Default: `budgetGuard` over the `llm.budget` settings
   * (the default weekly budget when none is set); `false` disables it.
   */
  budgets?: BudgetGuard | false
  log?: (line: string) => void
  /** Test seams of `createAgent`. */
  agentOptions?: Pick<CreateAgentOptions, 'query' | 'languageModel' | 'maxTurns'>
  /**
   * Shared per-credential limits (concurrency, tokens per minute, daily caps). Every job using the
   * same provider credential draws from one budget, so parallel jobs cannot exhaust a key together.
   */
  rateLimiter?: Limiter
  /** Listings the model tiers resolve against. Default: `modelCatalog()`. */
  models?: ModelCatalog
  /** Models and prices of `ai-sdk` providers, for model tiers and cost. */
  aiCatalog?: AiCatalog
  /** Providers `ai-sdk` credentials may name by `package` besides the shipped AI SDK packages. */
  aiProviders?: readonly AiProviderPlugin[]
}

/** Prices of the listed models that have them, by model id; `undefined` when none do. */
function pricingOf(listing: ModelListing): Record<string, ModelPricing> | undefined {
  const priced = listing.models.flatMap((m) => (m.pricing ? [[m.id, m.pricing] as const] : []))
  return priced.length ? Object.fromEntries(priced) : undefined
}

/**
 * Prices of the catalog's `anthropic` provider, for the one-shots and fallback tool loops that
 * Anthropic and Anthropic-compatible credentials run on the AI SDK; `undefined` without a catalog
 * or when it cannot be read.
 */
async function anthropicCatalogPricing(
  catalog: AiCatalog | undefined,
): Promise<Record<string, ModelPricing> | undefined> {
  const providers = await catalog?.providers().catch(() => undefined)
  const models = providers?.find((provider) => provider.id === 'anthropic')?.models ?? []
  const priced = models.flatMap((m) => (m.pricing ? [[m.id, m.pricing] as const] : []))
  return priced.length ? Object.fromEntries(priced) : undefined
}

/** What a caller may tell `settingsAgentFor` about the job an agent is for. */
interface AgentJob extends AgentRunOrigin {
  /** The job's command runner, e.g. the container runner. */
  runner?: CommandRunner
  /** The person the runs answer; tools then read only what they may read too. */
  requester?: Principal
}

/**
 * `AgentFor` that may also receive the job's runner and identity. A `RepoTarget` keeps its groups
 * instead of resolving them from the config, so stand-in targets (chat threads without a
 * repository) work too.
 */
export type ServerAgentFor = (
  repo: RepoRef | RepoTarget,
  job?: AgentJob,
) => Promise<Agent | undefined>

/**
 * The agent for a repository from settings, wrapped with `withServerDefaults` (tools, knowledge,
 * budgets, usage recording). The global `llm.provider` names an AI provider credential (id or
 * name, scope covering the repository), opened with the vault. Tasks run on their model tier,
 * resolved against the credential's model listing (`resolveTierModels`). Unset, no agent —
 * analyzers then run without one; a named provider that is missing, invalid or lists no Claude
 * model at all is logged and also yields no agent. A tier whose family is not listed runs on the
 * nearest listed tier, logged once per credential version. Runs of one provider credential share its
 * `maxConcurrency`. The credential's stored probe result (`capabilities.agentLoop`) picks the loop
 * of tool-loop tasks (`runtimeFor`).
 */
export function settingsAgentFor(options: SettingsAgentOptions): ServerAgentFor {
  const { config, store, vault } = options
  const now = options.now ?? (() => new Date())
  const log = options.log ?? (() => {})
  const limiters = new Map<string, ConcurrencyLimiter>()
  const tierNotes = new Set<string>()
  const apiCatalog = createApiCatalog({ analyses: store.analyses })
  const usageIndex = createUsageIndex({ analyses: store.analyses })
  const resolveGuide = createGuideResolver({ store })
  const testIds = testIdsReader({ store })
  const configuredTarget = (value: string) => {
    const separator = value.indexOf(':')
    if (separator < 1 || separator === value.length - 1) return undefined
    const forge = value.slice(0, separator)
    if (!config.forges[forge]) return undefined
    return repoTarget(config, { forge, path: value.slice(separator + 1) })
  }
  const catalog =
    options.models ?? modelCatalog(options.aiCatalog ? { catalog: options.aiCatalog } : {})
  const budgets =
    options.budgets === false
      ? undefined
      : (options.budgets ??
        budgetGuard({
          settings: store.settings,
          usage: store.aiUsage,
          audit: store.audit,
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
    const target = 'groups' in repo ? repo : repoTarget(config, repo)
    const entries = await store.settings.list()
    const runner = job?.runner ?? options.runner

    const reference = providerReference(entries)
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
      void options.credentials?.markUsed(credential.id)
      const key = `${credential.id}:${credential.updatedAt}`
      const listing = await catalog.list(key, aiProvider)
      const pricing =
        credential.kind === 'ai-sdk'
          ? pricingOf(listing)
          : await anthropicCatalogPricing(options.aiCatalog)
      agent = createAgent(aiProvider, {
        ...(credential.capabilities && { agentLoop: credential.capabilities.agentLoop }),
        ...options.agentOptions,
        tierModels: resolveTierModels(listing, {
          log: (message) => {
            const once = `${key}:${message}`
            if (tierNotes.has(once)) return
            tierNotes.add(once)
            log(`agent: provider "${credential.name}": ${message}`)
          },
        }),
        ...(runner && { runner }),
        ...(limiter && { limiter }),
        ...(pricing && { pricing }),
        ...(options.aiProviders && { plugins: options.aiProviders }),
      })
    } catch (error) {
      log(
        `agent: provider "${credential.name}": ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
    const provider = credential.name
    const limited = { key: credential.id, credential }
    const librariesConfig = librariesConfigFrom(entries)
    let self: Agent | undefined
    const libraries =
      store.libraries && options.artifacts
        ? serverLibraryDocs({
            libraries: store.libraries,
            artifacts: options.artifacts,
            ...(store.kv ? { kv: store.kv } : {}),
            github: () =>
              githubClientFor(
                {
                  list: () => store.credentials.list(),
                  reveal: async (id) => {
                    const found = (await store.credentials.list()).find((item) => item.id === id)
                    if (!found) throw new Error(`no credential ${id}`)
                    void options.credentials?.markUsed(id)
                    return vault.open(found.secret)
                  },
                },
                librariesConfig?.github,
                { log, ...(store.kv ? { kv: store.kv } : {}) },
              ),
            summarize: async () =>
              librariesConfig?.digests && self ? agentSummarize(self) : undefined,
          })
        : undefined

    const requester = job?.requester
    const releases = options.releases?.(target, requester)
    const ops = options.ops?.(target, requester)
    const tools = resolveSetting(entries, 'agent.tools', target)?.value
    const autoAccept = autoAcceptFrom(entries, target)
    const origin: AgentRunOrigin = {
      ...(job?.actor !== undefined && { actor: job.actor }),
      ...(job?.analyzer !== undefined && { analyzer: job.analyzer }),
      ...(job?.jobId !== undefined && { jobId: job.jobId }),
      ...(job?.interactive !== undefined && { interactive: job.interactive }),
      ...(job?.subject !== undefined && { subject: job.subject }),
    }
    const wrapped = withServerDefaults(agent, {
      repo: target,
      store,
      now,
      provider,
      origin,
      onRun,
      ...(budgets && { budgets }),
      ...(options.artifacts && { artifacts: options.artifacts }),
      ...(runner && { runner }),
      ...(isRecord(tools) && { tools }),
      ...(autoAccept.length > 0 && { autoAccept }),
      ...(libraries && { libraries }),
      ...(releases && { releases }),
      ...(ops && { ops }),
      ...(requester && { requester }),
      assets: storedAssetTools(store, {
        targetOf: (other) => repoTarget(config, other),
        canRead: (other) =>
          requester
            ? can(requester, 'analyses:read', { kind: 'repo', repo: other })
            : `${other.forge}:${other.path}` === `${target.forge}:${target.path}` ||
              other.groups.some((group) => target.groups.includes(group)),
        canReadScope: (scope) =>
          requester ? can(requester, 'settings:read', { kind: 'scope', scope }) : false,
      }),
      rules: agentRulesAccess({
        repo: target,
        ...(requester && { requester }),
        targetOf: configuredTarget,
        resolve: resolveGuide,
        testIds,
        families: () => store.families.list(),
      }),
      catalog: agentCatalogContext({
        catalog: apiCatalog,
        usages: usageIndex,
        store,
        repo: target,
        targetOf: (other) => repoTarget(config, other),
        policy: crossTeamOf(entries),
        ...(requester && { requester }),
        ...(options.artifacts && { artifacts: options.artifacts }),
        ...(options.supply && { supply: options.supply }),
        now,
      }),
      onRunError: (error) =>
        log(
          `agent: recording a run failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
    })
    self = wrapped
    if (!options.rateLimiter) return wrapped
    const configuredLimits = z
      .record(z.string(), limitPolicySchema)
      .safeParse(resolveSetting(entries, 'limits.credentials', target)?.value)
    self = limitAgent(
      wrapped,
      options.rateLimiter,
      limited.key,
      resolveLimitPolicy(
        limited.credential,
        configuredLimits.success ? configuredLimits.data : undefined,
      ),
    )
    return self
  }
}
