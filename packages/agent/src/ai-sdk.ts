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
  type SystemModelMessage,
  type ToolSet,
  generateText,
  jsonSchema,
  stepCountIs,
  tool,
} from 'ai'
import { createOllama } from 'ollama-ai-provider-v2'
import { z } from 'zod'

import { BudgetExceededError, budgetExceededFrom } from './errors.ts'
import {
  DEFAULT_LOCAL_TOOL_LIMITS,
  type LocalToolLimits,
  clipOutput,
  localTools,
} from './local-tools.ts'
import { mcpToolName } from './mcp.ts'
import { AgentOutputError, parseAgentOutput } from './output.ts'
import type { AiProviderPlugin } from './plugin.ts'
import { type AiSdkPackage, costFromPricing, mapModel, type ModelPricing } from './provider.ts'
import { DEFAULT_TIER, TIERS, type TierModels } from './tiers.ts'
import type { TranscriptSink } from './transcript.ts'
import type {
  Agent,
  AgentCapability,
  AgentResult,
  AgentTask,
  AgentTool,
  AgentUsage,
  ToolContext,
} from './types.ts'

/** How to reach a provider through its AI SDK package. */
export interface AiSdkConnection {
  /** AI SDK provider package: one of `AI_SDK_PACKAGES` or an `AiProviderPlugin`'s. */
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

/**
 * Whether Holtkeeper can talk to a catalog provider: its package ships or is a plugin's, or it has
 * an OpenAI-compatible API.
 */
export const isSupportedProvider = (
  provider: { package: string; api?: string },
  plugins: readonly AiProviderPlugin[] = [],
) =>
  AI_SDK_PACKAGES.includes(provider.package) ||
  plugins.some((plugin) => plugin.package === provider.package) ||
  provider.api !== undefined

/**
 * The AI SDK language model `modelId` of a provider: through the plugin whose `package` matches,
 * else the shipped package. Throws for a package neither provides.
 */
export function aiSdkLanguageModel(
  connection: AiSdkConnection,
  modelId: string,
  plugins: readonly AiProviderPlugin[] = [],
): LanguageModel {
  const plugin = plugins.find((p) => p.package === connection.package)
  if (plugin) return plugin.languageModel(connection, modelId)
  const factory = (factories as Record<string, ModelFactory | undefined>)[connection.package]
  if (!factory) throw new Error(`AI SDK package ${connection.package} is not available`)
  return factory(connection)(modelId)
}

/** Turn limit for tasks that set none and agents without `maxTurns`. */
export const DEFAULT_AI_SDK_MAX_TURNS = 40

export interface AiSdkAgentOptions {
  /** The language model for a provider model name, e.g. `(id) => aiSdkLanguageModel(connection, id)`. */
  languageModel: (modelId: string) => LanguageModel
  /** Model of each tier, e.g. from `resolveTierModels`. */
  tierModels: TierModels
  /** Logical model id → the provider's name for it; applied after tier resolution. */
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

const DEFAULT_CAPABILITIES: readonly AgentCapability[] = ['read', 'search']

function outputSchemaText(schema: z.ZodType): string {
  try {
    return JSON.stringify(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }))
  } catch {
    return ''
  }
}

/** System prompt of the tool loop: instructions, context, confinement, tools and answer format. */
function toolLoopSystemPrompt(task: AgentTask, tools: readonly string[]): string {
  const parts: string[] = []
  if (task.system?.trim()) parts.push(task.system.trim())
  if (task.context?.trim()) parts.push(task.context.trim())
  parts.push(
    [
      'You work in a repository checkout. Paths are relative to its root; nothing outside it can be read, written or run.',
      `Available tools: ${tools.join(', ') || 'none'}. Call tools to inspect the code instead of guessing. Do not ask for user input; nobody will answer.`,
      tools.includes('edit_file') ? '' : 'Do not modify files.',
    ]
      .filter(Boolean)
      .join('\n'),
  )
  if (task.output) {
    const schema = outputSchemaText(task.output)
    parts.push(
      [
        'Your final message must be a single JSON value matching the format the task describes, with no prose around it.',
        schema ? `JSON schema of the answer: ${schema}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }
  return parts.join('\n\n')
}

/** Built-in and toolset tools by their function name; throws on duplicate names. */
function toolLoopTools(
  task: AgentTask,
  options: Pick<AiSdkAgentOptions, 'runner' | 'limits'>,
): Map<string, AgentTool> {
  const tools = new Map<string, AgentTool>()
  const all = [
    ...localTools(task.capabilities ?? DEFAULT_CAPABILITIES, {
      ...options,
      ...(task.commands && { commands: task.commands }),
      ...(task.env && { env: task.env }),
    }),
    ...(task.toolsets ?? []).flatMap((toolset) => toolset.tools),
  ]
  for (const agentTool of all) {
    const name = mcpToolName(agentTool.name).slice(0, 64)
    if (tools.has(name)) throw new Error(`duplicate agent tool ${agentTool.name}`)
    tools.set(name, agentTool)
  }
  return tools
}

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

interface TranscribedStep {
  text: string
  toolCalls: readonly { toolCallId: string; toolName: string; input: unknown }[]
  toolResults: readonly { toolCallId: string; toolName: string; output: unknown }[]
}

/** Writes one tool-loop step (model text, tool calls, their results) to `sink`. */
function transcribeStep(step: TranscribedStep, sink: TranscriptSink): void {
  const toolCalls = step.toolCalls.map((call) => ({
    id: call.toolCallId,
    name: call.toolName,
    input: call.input,
  }))
  if (step.text || toolCalls.length)
    sink.write({
      type: 'assistant',
      ...(step.text && { text: step.text }),
      ...(toolCalls.length && { toolCalls }),
    })
  for (const result of step.toolResults) {
    const output =
      typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? null)
    sink.write({
      type: 'tool-result',
      id: result.toolCallId,
      name: result.toolName,
      output,
      ...(output.startsWith('error: ') && { isError: true }),
    })
  }
}

const emptyUsage = (): AgentUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

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

const CACHE_BREAKPOINT = { anthropic: { cacheControl: { type: 'ephemeral' } } }

const withBreakpoint = <Message extends ModelMessage>(message: Message): Message => ({
  ...message,
  providerOptions: {
    ...message.providerOptions,
    anthropic: { ...message.providerOptions?.['anthropic'], ...CACHE_BREAKPOINT.anthropic },
  },
})

/**
 * Moves one Anthropic cache breakpoint to the newest message of each step, so a step reads the
 * previous step's prefix from the cache. Earlier marks are undone because overrides carry forward
 * and Anthropic allows only four breakpoints per request.
 */
function movingBreakpoint() {
  const originals = new WeakMap<ModelMessage, ModelMessage>()
  return (messages: ModelMessage[]): ModelMessage[] => {
    const plain = messages.map((message) => originals.get(message) ?? message)
    const last = plain.at(-1)
    if (!last) return plain
    const marked = withBreakpoint(last)
    originals.set(marked, last)
    return [...plain.slice(0, -1), marked]
  }
}

/** Per-MTok prices assumed for a model without any, kept above every Claude tier's real prices. */
const UNPRICED_FALLBACK = {
  inputPerMTok: 15,
  outputPerMTok: 75,
  cacheReadPerMTok: 1.5,
  cacheWritePerMTok: 18.75,
}

/**
 * An `Agent` on the Vercel AI SDK: any provider with an AI SDK package, or any OpenAI-compatible
 * API. It runs a bounded tool loop (file tools confined to `task.dir`, `run_command` through `runner`, every `task.toolsets` tool; `task.mcpServers` are not
 * mounted), with tool calls executed one at a time, on `task.tier`'s model at the tier's reasoning
 * effort (providers without effort support ignore it). Cost comes from `pricing`. Anthropic models
 * (including routers and gateways on `@ai-sdk/anthropic`) get prompt-cache breakpoints on the
 * system prompt, which covers the tool definitions before it, and on the newest message of every
 * step. Structured output is parsed from the answer text, never forced through a tool. A spent
 * budget or quota fails the run with `BudgetExceededError`, and so does reaching
 * `task.maxCostUsd`: the loop stops after the step that reached it. A model `pricing` does not
 * price is costed at `UNPRICED_FALLBACK`, so caps and budgets still hold.
 */
export function createAiSdkAgent(options: AiSdkAgentOptions): Agent {
  const maxChars = options.limits?.maxOutputChars ?? DEFAULT_LOCAL_TOOL_LIMITS.maxOutputChars
  return {
    name: 'ai-sdk',
    async run<Output>(task: AgentTask<Output>): Promise<AgentResult<Output>> {
      const signal = task.signal ?? new AbortController().signal
      signal.throwIfAborted()
      const tier = task.tier ?? DEFAULT_TIER
      const logical = options.tierModels[tier]
      const modelId = mapModel(logical, options.modelMap)
      const model = options.languageModel(modelId)
      const ctx: ToolContext = { dir: resolve(task.dir), signal }
      const tools = toolLoopTools(task, options)
      const maxTurns = task.maxTurns ?? options.maxTurns ?? DEFAULT_AI_SDK_MAX_TURNS
      const system: SystemModelMessage = withBreakpoint({
        role: 'system',
        content: toolLoopSystemPrompt(task, [...tools.keys()]),
      })
      const mark = movingBreakpoint()
      const set = toolSet(tools, ctx, maxChars)
      const sink = task.transcript
      const costOf = (sum: AgentUsage) =>
        costFromPricing(sum, options.pricing, modelId, logical) ??
        costFromPricing(sum, { [modelId]: UNPRICED_FALLBACK }, modelId)
      sink?.write({
        type: 'start',
        runtime: 'ai-sdk',
        model: modelId,
        tier,
        ...(task.taskKind && { taskKind: task.taskKind }),
        tools: [...tools.keys()],
        system: system.content,
        prompt: task.prompt,
      })
      try {
        const answer = await loop()
        sink?.write({
          type: 'end',
          outcome: 'ok',
          turns: answer.turns,
          ...(answer.usage && { usage: answer.usage }),
          ...(answer.costUsd !== undefined && { costUsd: answer.costUsd }),
        })
        return answer
      } catch (error) {
        sink?.write({
          type: 'end',
          outcome: 'error',
          error: errorText(error),
          ...(error instanceof BudgetExceededError && {
            ...(error.turns !== undefined && { turns: error.turns }),
            ...(error.usage && { usage: error.usage }),
            ...(error.costUsd !== undefined && { costUsd: error.costUsd }),
          }),
        })
        throw error
      }

      async function loop(): Promise<AgentResult<Output>> {
        let messages: ModelMessage[] = [{ role: 'user', content: task.prompt }]
        let usage = emptyUsage()
        let turns = 0
        const cap = task.maxCostUsd
        const overCap = ({ steps }: { steps: { usage: LanguageModelUsage }[] }) => {
          if (cap === undefined) return false
          const cost = costOf(steps.reduce((sum, step) => addUsage(sum, step.usage), usage))
          return cost !== undefined && cost >= cap
        }

        for (let attempt = 0; attempt < 2; attempt++) {
          // oxlint-disable-next-line no-await-in-loop -- a retry continues the same conversation
          const result = await generateText({
            model,
            system,
            messages,
            ...(tools.size && { tools: set, toolCallConcurrency: 1 }),
            prepareStep: ({ messages: current }) => ({ messages: mark(current) }),
            stopWhen: [stepCountIs(Math.max(maxTurns - turns, 1)), overCap],
            reasoning: TIERS[tier].effort,
            abortSignal: signal,
            ...(options.timeoutMs !== undefined && { timeout: options.timeoutMs }),
          }).catch((error: unknown) => {
            throw budgetExceededFrom(error) ?? error
          })
          signal.throwIfAborted()
          if (sink) for (const step of result.steps) transcribeStep(step, sink)
          turns += result.steps.length
          usage = addUsage(usage, result.totalUsage)
          const spent = costOf(usage)
          const capped = cap !== undefined && spent !== undefined && spent >= cap
          const overBudget = () =>
            new BudgetExceededError(
              `AI budget exceeded: the run spent $${spent?.toFixed(2)} of its $${cap?.toFixed(2)} cap`,
              { usage, ...(spent !== undefined && { costUsd: spent }), turns },
            )
          if (result.finishReason === 'tool-calls' && capped) throw overBudget()
          if (result.finishReason === 'tool-calls') {
            throw new Error(
              `ai-sdk agent failed (error_max_turns): no answer within ${maxTurns} turns`,
            )
          }
          const answer: AgentResult<Output> = {
            text: result.text,
            turns,
            usage,
            model: modelId,
            runtime: 'ai-sdk',
          }
          if (spent !== undefined) answer.costUsd = spent
          if (!task.output) return answer
          try {
            answer.output = parseAgentOutput(result.text, task.output)
            return answer
          } catch (error) {
            if (attempt > 0 || turns >= maxTurns || !(error instanceof AgentOutputError))
              throw error
            if (capped) throw overBudget()
            messages = [
              ...messages,
              ...result.responseMessages,
              { role: 'user', content: `${error.message}. Answer again with only the JSON value.` },
            ]
          }
        }
        throw new Error('ai-sdk agent failed: no valid answer')
      }
    },
  }
}
