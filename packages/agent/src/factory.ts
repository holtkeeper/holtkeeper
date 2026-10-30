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
import { createOpenAICompatibleAgent, type OpenAICompatibleAgentDependencies } from './openai.ts'
import {
  type AiProvider,
  type AiProviderKind,
  type ModelPricing,
  type ProviderOptions,
  mapModel,
  parseProviderOptions,
  renderHeaders,
} from './provider.ts'
import type { Agent, AgentResult, AgentTask } from './types.ts'

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

/** A one-word reply of an `ai-sdk` provider's `model` and how long it took; throws on failure. */
export async function pingAiSdkProvider(
  provider: AiProvider,
  model: string,
  options: { signal?: AbortSignal; languageModel?: (modelId: string) => LanguageModel } = {},
): Promise<{ text: string; latencyMs: number }> {
  const parsed = parseProviderOptions(provider)
  if (parsed.kind !== 'ai-sdk') throw new Error(`${parsed.kind} providers cannot be pinged`)
  const modelId = mapModel(model, parsed.modelMap)
  const started = Date.now()
  const result = await generateText({
    model:
      options.languageModel?.(modelId) ??
      aiSdkLanguageModel(aiSdkConnection(provider, parsed), modelId),
    prompt: 'Reply with the single word OK.',
    maxOutputTokens: 16,
    maxRetries: 0,
    ...(options.signal && { abortSignal: options.signal }),
  })
  return { text: result.text.trim(), latencyMs: Date.now() - started }
}

/** An agent built from a provider, telling which provider kind and model a task kind runs on. */
export interface ProviderAgent extends Agent {
  readonly provider: AiProviderKind
  /** The provider's model name for tasks of `taskKind` (routing and `modelMap` applied). */
  modelFor(taskKind?: string): string
}

export interface CreateAgentOptions {
  /** Runs `run_command` for the OpenAI-compatible adapter (e.g. the job's container runner). */
  runner?: CommandRunner
  /** Turn limit for tasks without their own. */
  maxTurns?: number
  /** Overrides the provider's default model and per-kind models (e.g. from settings). */
  model?: string
  models?: Record<string, string>
  /**
   * Limiter for `maxConcurrency`, shared by every agent built for the same provider; default a new
   * one per agent.
   */
  limiter?: ConcurrencyLimiter
  /** Prices to fall back on, e.g. from the catalog; the provider's `pricing` option wins. */
  pricing?: Record<string, ModelPricing>
  /** Test seams. */
  query?: ClaudeQuery
  fetch?: OpenAICompatibleAgentDependencies['fetch']
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
 * the credential `url`. Anthropic, Anthropic-compatible, Bedrock and Vertex providers run on the
 * Claude Agent SDK; OpenAI-compatible ones on the built-in tool loop; `ai-sdk` ones on the Vercel
 * AI SDK through their package (the OpenAI-compatible package falls back to the credential `url`).
 * `maxConcurrency` limits parallel runs of the returned agent.
 */
export function createAgent(provider: AiProvider, options: CreateAgentOptions = {}): ProviderAgent {
  const parsed = parseProviderOptions(provider)
  const routing = {
    ...((options.model ?? parsed.model) !== undefined && { model: options.model ?? parsed.model }),
    ...((options.models ?? parsed.models) !== undefined && {
      models: { ...parsed.models, ...options.models },
    }),
  }
  const shared = {
    ...routing,
    ...(parsed.modelMap && { modelMap: parsed.modelMap }),
    ...((parsed.pricing || options.pricing) && {
      pricing: { ...options.pricing, ...parsed.pricing },
    }),
    ...(parsed.timeoutMs !== undefined && { timeoutMs: parsed.timeoutMs }),
    ...(options.maxTurns !== undefined && { maxTurns: options.maxTurns }),
  }
  const baseUrl = parsed.baseUrl ?? provider.url

  let agent: Agent
  if (parsed.kind === 'ai-sdk') {
    const connection = aiSdkConnection(provider, parsed)
    agent = createAiSdkAgent({
      ...shared,
      languageModel:
        options.languageModel ?? ((modelId) => aiSdkLanguageModel(connection, modelId)),
      ...(options.runner && { runner: options.runner }),
    })
  } else if (parsed.kind === 'openai-compatible') {
    const headers = renderHeaders(parsed.headers, provider.secret)
    const auth = Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')
    agent = createOpenAICompatibleAgent(
      {
        ...shared,
        baseUrl,
        headers,
        ...(!auth && { apiKey: provider.secret }),
        ...(parsed.jsonMode !== undefined && { jsonMode: parsed.jsonMode }),
        ...(options.runner && { runner: options.runner }),
      },
      options.fetch ? { fetch: options.fetch } : {},
    )
  } else {
    const claude: ClaudeAgentOptions = { ...shared, apiKey: provider.secret }
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
      case 'bedrock':
        claude.connection = {
          kind: 'bedrock',
          region: parsed.region,
          credentials: parsed.credentials,
          ...(parsed.baseUrl && { baseUrl: parsed.baseUrl }),
        }
        break
      case 'vertex':
        claude.connection = {
          kind: 'vertex',
          region: parsed.region,
          projectId: parsed.projectId,
          credentials: parsed.credentials,
          ...(parsed.baseUrl && { baseUrl: parsed.baseUrl }),
        }
        break
    }
    agent = options.query
      ? createClaudeAgent(claude, { query: options.query })
      : claudeAgent(claude)
  }

  const withProvider: ProviderAgent = {
    name: agent.name,
    provider: parsed.kind,
    modelFor: (taskKind) =>
      mapModel(
        parsed.kind === 'ai-sdk'
          ? (taskKind !== undefined && routing.models?.[taskKind]) || routing.model || ''
          : modelFor(routing, taskKind),
        parsed.modelMap,
      ),
    run: (task) => agent.run(task),
  }
  if (!parsed.maxConcurrency) return withProvider
  return limitConcurrency(withProvider, options.limiter ?? parsed.maxConcurrency)
}
