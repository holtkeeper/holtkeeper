import { resolve } from 'node:path'

import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createAzure } from '@ai-sdk/azure'
import { createCerebras } from '@ai-sdk/cerebras'
import { createCohere } from '@ai-sdk/cohere'
import { createDeepInfra } from '@ai-sdk/deepinfra'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createFireworks } from '@ai-sdk/fireworks'
import { createGateway } from '@ai-sdk/gateway'
import { createGoogle } from '@ai-sdk/google'
import { createGoogleVertex } from '@ai-sdk/google-vertex'
import { createGoogleVertexAnthropic } from '@ai-sdk/google-vertex/anthropic'
import { createGroq } from '@ai-sdk/groq'
import { createMistral } from '@ai-sdk/mistral'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createPerplexity } from '@ai-sdk/perplexity'
import { createTogetherAI } from '@ai-sdk/togetherai'
import { createXai } from '@ai-sdk/xai'
import type { CommandRunner } from '@holtkeeper/exec'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import {
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
  generateText,
  jsonSchema,
  stepCountIs,
  tool,
} from 'ai'
import { createOllama } from 'ollama-ai-provider-v2'
import { z } from 'zod'

import { DEFAULT_LOCAL_TOOL_LIMITS, type LocalToolLimits, clipOutput } from './local-tools.ts'
import { openAISystemPrompt, openAITools } from './openai.ts'
import { AgentOutputError, parseAgentOutput } from './output.ts'
import { type AiSdkPackage, costFromPricing, mapModel, type ModelPricing } from './provider.ts'
import type { Agent, AgentResult, AgentTask, AgentTool, AgentUsage, ToolContext } from './types.ts'

/** How to reach a provider through its AI SDK package. */
export interface AiSdkConnection {
  /** AI SDK provider package, one of `AI_SDK_PACKAGES`. */
  package: string
  /** Provider label, e.g. the catalog id; names OpenAI-compatible providers in requests. */
  name: string
  /** API key, or for Vertex and Bedrock optionally their credentials as JSON. */
  secret: string
  baseUrl?: string
  headers?: Record<string, string>
  /** Further settings of the package's `create...` function, e.g. `region` or `project`. */
  settings?: Record<string, unknown>
}

/** A provider's language model by model name. */
export type LanguageModelFactory = (modelId: string) => LanguageModel

type ModelFactory = (connection: AiSdkConnection) => LanguageModelFactory

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function jsonSecret(secret: string): Record<string, unknown> | undefined {
  if (!secret.trimStart().startsWith('{')) return undefined
  try {
    const parsed: unknown = JSON.parse(secret)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const common = (c: AiSdkConnection) => ({
  ...c.settings,
  ...(c.secret && { apiKey: c.secret }),
  ...(c.baseUrl && { baseURL: c.baseUrl }),
  ...(c.headers && { headers: c.headers }),
})

const text = (value: unknown) => (typeof value === 'string' ? value : undefined)

const factories: Record<AiSdkPackage, ModelFactory> = {
  '@ai-sdk/openai': (c) => createOpenAI(common(c)),
  '@ai-sdk/openai-compatible': (c) => {
    if (!c.baseUrl) throw new Error(`${c.name}: an OpenAI-compatible provider needs a base URL`)
    const provider = createOpenAICompatible({
      ...common(c),
      name: c.name,
      baseURL: c.baseUrl,
      includeUsage: true,
    })
    return (modelId) => provider(modelId)
  },
  '@ai-sdk/anthropic': (c) => createAnthropic(common(c)),
  '@ai-sdk/google': (c) => createGoogle(common(c)),
  '@ai-sdk/google-vertex': (c) => {
    const credentials = jsonSecret(c.secret)
    return createGoogleVertex(
      credentials
        ? { ...common({ ...c, secret: '' }), googleAuthOptions: { credentials } }
        : common(c),
    )
  },
  '@ai-sdk/google-vertex/anthropic': (c) => {
    const credentials = jsonSecret(c.secret)
    return createGoogleVertexAnthropic(
      credentials
        ? { ...common({ ...c, secret: '' }), googleAuthOptions: { credentials } }
        : common(c),
    )
  },
  '@ai-sdk/amazon-bedrock': (c) => {
    const keys = jsonSecret(c.secret)
    if (!keys) return createAmazonBedrock(common(c))
    const sessionToken = text(keys.sessionToken)
    return createAmazonBedrock({
      ...common({ ...c, secret: '' }),
      ...(text(keys.accessKeyId) && { accessKeyId: text(keys.accessKeyId) }),
      ...(text(keys.secretAccessKey) && { secretAccessKey: text(keys.secretAccessKey) }),
      ...(sessionToken && { sessionToken }),
    })
  },
  '@ai-sdk/azure': (c) => createAzure(common(c)),
  '@ai-sdk/mistral': (c) => createMistral(common(c)),
  '@ai-sdk/groq': (c) => createGroq(common(c)),
  '@ai-sdk/xai': (c) => createXai(common(c)),
  '@ai-sdk/deepseek': (c) => createDeepSeek(common(c)),
  '@ai-sdk/cohere': (c) => createCohere(common(c)),
  '@ai-sdk/togetherai': (c) => createTogetherAI(common(c)),
  '@ai-sdk/fireworks': (c) => createFireworks(common(c)),
  '@ai-sdk/cerebras': (c) => createCerebras(common(c)),
  '@ai-sdk/deepinfra': (c) => createDeepInfra(common(c)),
  '@ai-sdk/perplexity': (c) => createPerplexity(common(c)),
  '@ai-sdk/gateway': (c) => createGateway(common(c)),
  '@openrouter/ai-sdk-provider': (c) => createOpenRouter(common(c)),
  'ollama-ai-provider-v2': (c) => createOllama({ ...common({ ...c, secret: '' }) }),
}

/** AI SDK provider packages Holtkeeper ships; any other provider goes through `@ai-sdk/openai-compatible`. */
export const AI_SDK_PACKAGES: readonly string[] = Object.keys(factories)

/** Whether Holtkeeper can talk to a catalog provider: its package ships, or it has an OpenAI-compatible API. */
export const isSupportedProvider = (provider: { package: string; api?: string }) =>
  AI_SDK_PACKAGES.includes(provider.package) || provider.api !== undefined

/** The AI SDK language model `modelId` of a provider. Throws for a package Holtkeeper does not ship. */
export function aiSdkLanguageModel(connection: AiSdkConnection, modelId: string): LanguageModel {
  const factory = (factories as Record<string, ModelFactory | undefined>)[connection.package]
  if (!factory) throw new Error(`AI SDK package ${connection.package} is not available`)
  return factory(connection)(modelId)
}

/** Turn limit for tasks that set none and agents without `maxTurns`. */
export const DEFAULT_AI_SDK_MAX_TURNS = 40

export interface AiSdkAgentOptions {
  /** The language model for a provider model name, e.g. `(id) => aiSdkLanguageModel(connection, id)`. */
  languageModel: (modelId: string) => LanguageModel
  /** Default model; `models[taskKind]` wins. There is no built-in default. */
  model?: string
  models?: Record<string, string>
  /** Logical model id → the provider's name for it; applied after routing. */
  modelMap?: Record<string, string>
  /** Prices per model for cost. */
  pricing?: Record<string, ModelPricing>
  /** Timeout of one model request. */
  timeoutMs?: number
  /** Turn limit for tasks without their own. Default `DEFAULT_AI_SDK_MAX_TURNS`. */
  maxTurns?: number
  /** Runs `run_command`; without it the `run` capability grants no tool. */
  runner?: CommandRunner
  limits?: Partial<LocalToolLimits>
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function runTool(agentTool: AgentTool, input: unknown, ctx: ToolContext, maxChars: number) {
  try {
    const parsed = agentTool.input.safeParse(input)
    if (!parsed.success)
      return `error: invalid arguments: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`
    return clipOutput(await agentTool.run(parsed.data, ctx), maxChars)
  } catch (error) {
    ctx.signal.throwIfAborted()
    return `error: ${errorText(error)}`
  }
}

function toolSet(tools: Map<string, AgentTool>, ctx: ToolContext, maxChars: number): ToolSet {
  return Object.fromEntries(
    [...tools].map(([name, agentTool]) => {
      const { $schema: _, ...schema } = z.toJSONSchema(agentTool.input, {
        io: 'input',
        unrepresentable: 'any',
      })
      return [
        name,
        tool({
          description: agentTool.description,
          inputSchema: jsonSchema(schema),
          execute: (input: unknown) => runTool(agentTool, input, ctx, maxChars),
        }),
      ]
    }),
  )
}

const addUsage = (sum: AgentUsage, usage: LanguageModelUsage): AgentUsage => {
  const cacheRead = usage.inputTokenDetails.cacheReadTokens ?? 0
  const cacheWrite = usage.inputTokenDetails.cacheWriteTokens ?? 0
  const input =
    usage.inputTokenDetails.noCacheTokens ??
    Math.max((usage.inputTokens ?? 0) - cacheRead - cacheWrite, 0)
  return {
    inputTokens: sum.inputTokens + input,
    outputTokens: sum.outputTokens + (usage.outputTokens ?? 0),
    cacheReadTokens: sum.cacheReadTokens + cacheRead,
    cacheWriteTokens: sum.cacheWriteTokens + cacheWrite,
  }
}

/** The model name for a task kind: `models[taskKind]`, then `model`; throws without either. */
function routedModel(options: Pick<AiSdkAgentOptions, 'model' | 'models'>, taskKind?: string) {
  const model = (taskKind !== undefined && options.models?.[taskKind]) || options.model
  if (!model) throw new Error('no model configured: set llm.model or the provider model')
  return model
}

/**
 * An `Agent` on the Vercel AI SDK: any provider with an AI SDK package, or any OpenAI-compatible
 * API. It runs the same bounded tool loop as the OpenAI-compatible adapter (file tools confined to
 * `task.dir`, `run_command` through `runner`, every `task.toolsets` tool; `task.mcpServers` are not
 * mounted), with tool calls executed one at a time. Cost comes from `pricing`.
 */
export function createAiSdkAgent(options: AiSdkAgentOptions): Agent {
  const maxChars = options.limits?.maxOutputChars ?? DEFAULT_LOCAL_TOOL_LIMITS.maxOutputChars
  return {
    name: 'ai-sdk',
    async run<Output>(task: AgentTask<Output>): Promise<AgentResult<Output>> {
      const signal = task.signal ?? new AbortController().signal
      signal.throwIfAborted()
      const logical = routedModel(options, task.taskKind)
      const modelId = mapModel(logical, options.modelMap)
      const model = options.languageModel(modelId)
      const ctx: ToolContext = { dir: resolve(task.dir), signal }
      const tools = openAITools(task, options)
      const maxTurns = task.maxTurns ?? options.maxTurns ?? DEFAULT_AI_SDK_MAX_TURNS
      const system = openAISystemPrompt(task, [...tools.keys()])
      const set = toolSet(tools, ctx, maxChars)
      let messages: ModelMessage[] = [{ role: 'user', content: task.prompt }]
      let usage: AgentUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }
      let turns = 0

      for (let attempt = 0; attempt < 2; attempt++) {
        // oxlint-disable-next-line no-await-in-loop -- a retry continues the same conversation
        const result = await generateText({
          model,
          system,
          messages,
          ...(tools.size && { tools: set, toolCallConcurrency: 1 }),
          stopWhen: stepCountIs(Math.max(maxTurns - turns, 1)),
          abortSignal: signal,
          ...(options.timeoutMs !== undefined && { timeout: options.timeoutMs }),
        })
        signal.throwIfAborted()
        turns += result.steps.length
        usage = addUsage(usage, result.totalUsage)
        if (result.finishReason === 'tool-calls') {
          throw new Error(
            `ai-sdk agent failed (error_max_turns): no answer within ${maxTurns} turns`,
          )
        }
        const answer: AgentResult<Output> = { text: result.text, turns, usage }
        const cost = costFromPricing(usage, options.pricing, modelId, logical)
        if (cost !== undefined) answer.costUsd = cost
        if (!task.output) return answer
        try {
          answer.output = parseAgentOutput(result.text, task.output)
          return answer
        } catch (error) {
          if (attempt > 0 || turns >= maxTurns || !(error instanceof AgentOutputError)) throw error
          messages = [
            ...messages,
            ...result.responseMessages,
            { role: 'user', content: `${error.message}. Answer again with only the JSON value.` },
          ]
        }
      }
      throw new Error('ai-sdk agent failed: no valid answer')
    },
  }
}
