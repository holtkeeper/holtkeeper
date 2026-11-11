import type { CommandRunner } from '@holtkeeper/exec'
import { type LanguageModel, generateText } from 'ai'

import { type AiSdkConnection, aiSdkLanguageModel, createAiSdkAgent } from './ai-sdk.ts'
import {
  type ClaudeAgentOptions,
  type ClaudeQuery,
  claudeAgent,
  createClaudeAgent,
  modelFor,
} from './claude.ts'
import { type AiProviderPlugin, aiSdkPackages } from './plugin.ts'
import {
  type AiProvider,
  type AiProviderKind,
  type ModelPricing,
  type ProviderOptions,
  mapModel,
  parseProviderOptions,
  renderHeaders,
} from './provider.ts'
import { FALLBACK_TIER_MODELS, type ModelTier, type TierModels } from './tiers.ts'
import { type AgentRuntime, redactingSink } from './transcript.ts'
import type { Agent, AgentResult, AgentTask } from './types.ts'

/**
 * What a probe of the provider found about Messages tool use, which the Claude Agent SDK loop
 * needs: `ok`, `failed`, or `unknown` when no probe ran yet.
 */
export type AgentLoopStatus = 'ok' | 'failed' | 'unknown'

/**
 * Whether a task needs a tool loop: it may touch the checkout (any capability; none given means
 * the default `read` and `search`), or mounts toolsets or MCP servers. Everything else is a
 * one-shot call.
 */
export function needsToolLoop(task: Pick<AgentTask, 'capabilities' | 'toolsets' | 'mcpServers'>) {
  return (
    task.capabilities === undefined ||
    task.capabilities.length > 0 ||
    (task.toolsets ?? []).some((toolset) => toolset.tools.length > 0) ||
    Object.keys(task.mcpServers ?? {}).length > 0
  )
}

/**
 * The loop a task runs on. `ai-sdk` providers always use the AI SDK. Anthropic and
 * Anthropic-compatible providers run tool-loop tasks (`needsToolLoop`) on the Claude Agent SDK
 * unless a probe found their Messages tool use broken (`agentLoop: 'failed'`), and one-shots on
 * the AI SDK's Anthropic provider.
 */
export function runtimeFor(
  kind: AiProviderKind,
  task: Pick<AgentTask, 'capabilities' | 'toolsets' | 'mcpServers'>,
  agentLoop: AgentLoopStatus = 'unknown',
): AgentRuntime {
  if (kind === 'ai-sdk' || !needsToolLoop(task)) return 'ai-sdk'
  return agentLoop === 'failed' ? 'ai-sdk' : 'claude-sdk'
}

/** The Messages API root an Anthropic or Anthropic-compatible provider is reached at, without `/v1`. */
const messagesRoot = (baseUrl: string) => baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')

/**
 * The `@ai-sdk/anthropic` connection of an Anthropic or Anthropic-compatible provider at
 * `baseUrl` (the Messages root Claude Code uses, with or without `/v1`): same endpoint, auth
 * header and rendered headers as the Claude Agent SDK gets.
 */
export function anthropicMessagesConnection(
  provider: AiProvider,
  parsed: Exclude<ProviderOptions, { kind: 'ai-sdk' }>,
  baseUrl: string,
): AiSdkConnection {
  const bearer = parsed.kind === 'anthropic-compatible' && parsed.authHeader === 'bearer'
  const headers =
    parsed.kind === 'anthropic-compatible' ? renderHeaders(parsed.headers, provider.secret) : {}
  return {
    package: '@ai-sdk/anthropic',
    name: parsed.kind,
    secret: bearer ? '' : provider.secret,
    baseUrl: `${messagesRoot(baseUrl)}/v1`,
    ...(Object.keys(headers).length > 0 && { headers }),
    ...(bearer && { settings: { authToken: provider.secret } }),
  }
}

type AiSdkOptions = Extract<ProviderOptions, { kind: 'ai-sdk' }>

/** How an `ai-sdk` provider is reached: its package, endpoint, secret, headers and settings. */
function aiSdkConnection(provider: AiProvider, parsed: AiSdkOptions): AiSdkConnection {
  const endpoint =
    parsed.baseUrl ?? (parsed.package === '@ai-sdk/openai-compatible' ? provider.url : undefined)
  return {
    package: parsed.package,
    name: parsed.provider,
    secret: provider.secret,
    ...(endpoint && { baseUrl: endpoint }),
    ...(parsed.headers && { headers: renderHeaders(parsed.headers, provider.secret) }),
    ...(parsed.settings && { settings: parsed.settings }),
  }
}

/** `parseProviderOptions` that also refuses an `ai-sdk` package neither shipped nor a plugin's. */
function parseWithPlugins(provider: AiProvider, plugins?: readonly AiProviderPlugin[]) {
  const parsed = parseProviderOptions(provider)
  if (parsed.kind === 'ai-sdk' && !aiSdkPackages(plugins).includes(parsed.package))
    throw new Error(
      `invalid AI provider: options.package: ${parsed.package} is not an available AI SDK package`,
    )
  return parsed
}

/** A one-word reply of an `ai-sdk` provider's `model` and how long it took; throws on failure. */
export async function pingAiSdkProvider(
  provider: AiProvider,
  model: string,
  options: {
    signal?: AbortSignal
    plugins?: readonly AiProviderPlugin[]
    languageModel?: (modelId: string) => LanguageModel
  } = {},
): Promise<{ text: string; latencyMs: number }> {
  const parsed = parseWithPlugins(provider, options.plugins)
  if (parsed.kind !== 'ai-sdk') throw new Error(`${parsed.kind} providers cannot be pinged`)
  const modelId = mapModel(model, parsed.modelMap)
  const started = Date.now()
  const result = await generateText({
    model:
      options.languageModel?.(modelId) ??
      aiSdkLanguageModel(aiSdkConnection(provider, parsed), modelId, options.plugins),
    prompt: 'Reply with the single word OK.',
    maxOutputTokens: 16,
    maxRetries: 0,
    ...(options.signal && { abortSignal: options.signal }),
  })
  return { text: result.text.trim(), latencyMs: Date.now() - started }
}

/** An agent built from a provider, telling which provider kind and model a tier runs on. */
export interface ProviderAgent extends Agent {
  readonly provider: AiProviderKind
  /** The provider's model name for tasks of `tier` (default `main`; `modelMap` applied). */
  modelFor(tier?: ModelTier): string
  /** The loop `task` would run on (`runtimeFor` with the provider's kind and probe result). */
  runtimeFor(task: AgentTask): AgentRuntime
}

export interface CreateAgentOptions {
  /** Runs `run_command` for the AI SDK tool loop (e.g. the job's container runner). */
  runner?: CommandRunner
  /** Turn limit for tasks without their own. */
  maxTurns?: number
  /** Model of each tier, e.g. `resolveTierModels` of the provider's listing. Default `FALLBACK_TIER_MODELS`. */
  tierModels?: TierModels
  /**
   * Limiter for `maxConcurrency`, shared by every agent built for the same provider; default a new
   * one per agent.
   */
  limiter?: ConcurrencyLimiter
  /** Prices to fall back on, e.g. from the catalog; the provider's `pricing` option wins. */
  pricing?: Record<string, ModelPricing>
  /** Providers `ai-sdk` credentials may name by `package` besides the shipped ones. */
  plugins?: readonly AiProviderPlugin[]
  /** The stored probe result of an Anthropic or Anthropic-compatible provider; see `runtimeFor`. */
  agentLoop?: AgentLoopStatus
  /** Test seams. */
  query?: ClaudeQuery
  languageModel?: (modelId: string) => LanguageModel
}

/** A shared slot pool: at most `max` callbacks run at once, the rest wait in order. */
export interface ConcurrencyLimiter {
  readonly max: number
  /** Runs `fn` in a slot; aborting `signal` while waiting rejects with its reason. */
  run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>
}

/** A limiter with `max` slots, to share between agents that use one provider. */
export function createLimiter(max: number): ConcurrencyLimiter {
  let active = 0
  const waiting: (() => void)[] = []
  const acquire = (signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      signal?.throwIfAborted()
      if (active < max) {
        active++
        resolve()
        return
      }
      const start = () => {
        signal?.removeEventListener('abort', onAbort)
        active++
        resolve()
      }
      const onAbort = () => {
        waiting.splice(waiting.indexOf(start), 1)
        reject(signal?.reason)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      waiting.push(start)
    })
  return {
    max,
    async run(fn, signal) {
      await acquire(signal)
      try {
        return await fn()
      } finally {
        active--
        waiting.shift()?.()
      }
    },
  }
}

/** `agent` whose runs take a slot of `limit` (a shared limiter, or a new one with that many slots). */
export function limitConcurrency<A extends Agent>(agent: A, limit: number | ConcurrencyLimiter): A {
  const limiter = typeof limit === 'number' ? createLimiter(limit) : limit
  return {
    ...agent,
    run: <Output>(task: AgentTask<Output>): Promise<AgentResult<Output>> =>
      limiter.run(() => agent.run(task), task.signal),
  }
}

/**
 * The agent for an AI provider credential. `kind` and `options` are validated with
 * `providerOptionsSchema` (throws listing every problem); the endpoint is `options.baseUrl`, else
 * the credential `url`. Each task runs on the loop `runtimeFor` picks with `options.agentLoop`:
 * Anthropic and Anthropic-compatible providers run tool loops on the Claude Agent SDK and one-shots
 * (or tool loops their probe failed) on the AI SDK's Anthropic provider at the same endpoint;
 * `ai-sdk` ones always run on the Vercel AI SDK through their package (the OpenAI-compatible
 * package falls back to the credential `url`). Tasks run on their tier's model from
 * `options.tierModels`. `maxConcurrency` limits parallel runs of the returned agent. An `ai-sdk`
 * package must ship or be one of `options.plugins`. A task's `transcript` never receives the
 * provider secret or rendered header values.
 */
export function createAgent(provider: AiProvider, options: CreateAgentOptions = {}): ProviderAgent {
  const parsed = parseWithPlugins(provider, options.plugins)
  const tierModels = options.tierModels ?? FALLBACK_TIER_MODELS
  const shared = {
    tierModels,
    ...(parsed.modelMap && { modelMap: parsed.modelMap }),
    ...(parsed.timeoutMs !== undefined && { timeoutMs: parsed.timeoutMs }),
    ...(options.maxTurns !== undefined && { maxTurns: options.maxTurns }),
  }
  const pricing =
    parsed.pricing || options.pricing ? { ...options.pricing, ...parsed.pricing } : undefined
  const baseUrl = parsed.baseUrl ?? provider.url
  const aiSdkAgent = (connection: AiSdkConnection) =>
    createAiSdkAgent({
      ...shared,
      ...(pricing && { pricing }),
      languageModel:
        options.languageModel ??
        ((modelId) => aiSdkLanguageModel(connection, modelId, options.plugins)),
      ...(options.runner && { runner: options.runner }),
    })

  const secrets = [
    provider.secret,
    ...Object.values(
      parsed.kind === 'ai-sdk' || parsed.kind === 'anthropic-compatible'
        ? renderHeaders(parsed.headers, provider.secret)
        : {},
    ),
  ]
  let route: (task: AgentTask) => Agent
  if (parsed.kind === 'ai-sdk') {
    const agent = aiSdkAgent(aiSdkConnection(provider, parsed))
    route = () => agent
  } else {
    const claude: ClaudeAgentOptions = {
      ...shared,
      ...(parsed.pricing && { pricing: parsed.pricing }),
      apiKey: provider.secret,
    }
    switch (parsed.kind) {
      case 'anthropic':
        claude.connection = { kind: 'anthropic', baseUrl }
        break
      case 'anthropic-compatible':
        claude.connection = {
          kind: 'anthropic-compatible',
          baseUrl,
          authHeader: parsed.authHeader,
          headers: renderHeaders(parsed.headers, provider.secret),
        }
        break
    }
    const sdk = options.query
      ? createClaudeAgent(claude, { query: options.query })
      : claudeAgent(claude)
    const messages = aiSdkAgent(anthropicMessagesConnection(provider, parsed, baseUrl))
    route = (task) =>
      runtimeFor(parsed.kind, task, options.agentLoop) === 'claude-sdk' ? sdk : messages
  }

  const withProvider: ProviderAgent = {
    name: parsed.kind === 'ai-sdk' ? 'ai-sdk' : 'claude',
    provider: parsed.kind,
    modelFor: (tier) => mapModel(modelFor({ tierModels }, tier), parsed.modelMap),
    runtimeFor: (task) => runtimeFor(parsed.kind, task, options.agentLoop),
    run: (task) =>
      route(task).run(
        task.transcript ? { ...task, transcript: redactingSink(task.transcript, secrets) } : task,
      ),
  }
  if (!parsed.maxConcurrency) return withProvider
  return limitConcurrency(withProvider, options.limiter ?? parsed.maxConcurrency)
}
