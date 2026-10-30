import { resolve } from 'node:path'

import type { CommandRunner } from '@holtkeeper/exec'
import { resolveSecret, type Secret } from '@holtkeeper/forge'
import { z } from 'zod'

import { modelFor } from './claude.ts'
import {
  DEFAULT_LOCAL_TOOL_LIMITS,
  type LocalToolLimits,
  clipOutput,
  localTools,
} from './local-tools.ts'
import { mcpToolName } from './mcp.ts'
import { AgentOutputError, parseAgentOutput } from './output.ts'
import { costFromPricing, mapModel, type ModelPricing } from './provider.ts'
import type {
  Agent,
  AgentCapability,
  AgentResult,
  AgentTask,
  AgentTool,
  AgentUsage,
  ToolContext,
} from './types.ts'

/** Turn limit for tasks that set none and agents without `maxTurns`. */
export const DEFAULT_OPENAI_MAX_TURNS = 40

export interface OpenAICompatibleAgentOptions {
  /** API root that `/chat/completions` is appended to, e.g. `https://llm.example.com/v1`. */
  baseUrl: string
  /** Sent as `Authorization: Bearer <key>`; omit when `headers` carry the auth. */
  apiKey?: Secret
  /** Extra headers on every request; values are final. */
  headers?: Record<string, string>
  /** Default model; routing as in the Claude adapter (`models[taskKind]`, then `model`). */
  model?: string
  models?: Record<string, string>
  /** Logical model id → the provider's name for it; applied after routing. */
  modelMap?: Record<string, string>
  /** Prices per model; used when the response reports no cost. */
  pricing?: Record<string, ModelPricing>
  /** Timeout of one request. Default 300 000 ms. */
  timeoutMs?: number
  /** Turn limit for tasks without their own. Default `DEFAULT_OPENAI_MAX_TURNS`. */
  maxTurns?: number
  /** Ask for `response_format: { type: 'json_object' }` when a task has `output`. */
  jsonMode?: boolean
  /** Runs `run_command`; without it the `run` capability grants no tool. */
  runner?: CommandRunner
  limits?: Partial<LocalToolLimits>
}

export interface OpenAICompatibleAgentDependencies {
  fetch?: (input: string, init: RequestInit) => Promise<Response>
}

interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function').optional(),
  function: z.object({ name: z.string(), arguments: z.string().optional() }),
})

const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z.array(toolCallSchema).nullish(),
        }),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      prompt_tokens_details: z.object({ cached_tokens: z.number().optional() }).nullish(),
      cost: z.number().optional(),
    })
    .nullish(),
})

const DEFAULT_CAPABILITIES: readonly AgentCapability[] = ['read', 'search']
const DEFAULT_TIMEOUT_MS = 300_000

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function outputSchemaText(schema: z.ZodType): string {
  try {
    return JSON.stringify(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }))
  } catch {
    return ''
  }
}

/** System prompt of the tool loop: instructions, context, confinement, tools and answer format. */
export function openAISystemPrompt(task: AgentTask, tools: readonly string[]): string {
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
export function openAITools(
  task: AgentTask,
  options: Pick<OpenAICompatibleAgentOptions, 'runner' | 'limits'>,
): Map<string, AgentTool> {
  const tools = new Map<string, AgentTool>()
  const all = [
    ...localTools(task.capabilities ?? DEFAULT_CAPABILITIES, options),
    ...(task.toolsets ?? []).flatMap((toolset) => toolset.tools),
  ]
  for (const tool of all) {
    const name = mcpToolName(tool.name).slice(0, 64)
    if (tools.has(name)) throw new Error(`duplicate agent tool ${tool.name}`)
    tools.set(name, tool)
  }
  return tools
}

function toolDefinition(name: string, tool: AgentTool) {
  const { $schema: _, ...parameters } = z.toJSONSchema(tool.input, {
    io: 'input',
    unrepresentable: 'any',
  })
  return { type: 'function', function: { name, description: tool.description, parameters } }
}

async function callTool(
  tools: Map<string, AgentTool>,
  call: ToolCall,
  ctx: ToolContext,
  maxChars: number,
): Promise<string> {
  const tool = tools.get(call.function.name)
  if (!tool) return `error: ${call.function.name} is not available for this task`
  try {
    const raw: unknown = call.function.arguments ? JSON.parse(call.function.arguments) : {}
    const parsed = tool.input.safeParse(raw)
    if (!parsed.success)
      return `error: invalid arguments: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`
    return clipOutput(await tool.run(parsed.data, ctx), maxChars)
  } catch (error) {
    ctx.signal.throwIfAborted()
    return `error: ${errorText(error)}`
  }
}

function addUsage(
  sum: AgentUsage,
  usage: z.infer<typeof completionSchema>['usage'],
): { usage: AgentUsage; cost?: number } {
  const prompt = usage?.prompt_tokens ?? 0
  const cached = Math.min(usage?.prompt_tokens_details?.cached_tokens ?? 0, prompt)
  return {
    usage: {
      inputTokens: sum.inputTokens + prompt - cached,
      outputTokens: sum.outputTokens + (usage?.completion_tokens ?? 0),
      cacheReadTokens: sum.cacheReadTokens + cached,
      cacheWriteTokens: sum.cacheWriteTokens,
    },
    ...(usage?.cost !== undefined ? { cost: usage.cost } : {}),
  }
}

/**
 * `openAICompatibleAgent` with an injectable `fetch`, so tests can point it at a fake server or
 * script responses directly.
 */
export function createOpenAICompatibleAgent(
  options: OpenAICompatibleAgentOptions,
  dependencies: OpenAICompatibleAgentDependencies = {},
): Agent {
  const doFetch = dependencies.fetch ?? ((input, init) => fetch(input, init))
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const maxChars = options.limits?.maxOutputChars ?? DEFAULT_LOCAL_TOOL_LIMITS.maxOutputChars

  return {
    name: 'openai-compatible',
    async run<Output>(task: AgentTask<Output>): Promise<AgentResult<Output>> {
      const signal = task.signal ?? new AbortController().signal
      signal.throwIfAborted()
      const dir = resolve(task.dir)
      const logical = modelFor(options, task.taskKind)
      const model = mapModel(logical, options.modelMap)
      const tools = openAITools(task, options)
      const definitions = [...tools].map(([name, tool]) => toolDefinition(name, tool))
      const maxTurns = task.maxTurns ?? options.maxTurns ?? DEFAULT_OPENAI_MAX_TURNS
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...(options.apiKey !== undefined
          ? { authorization: `Bearer ${resolveSecret(options.apiKey)}` }
          : {}),
        ...options.headers,
      }
      const messages: ChatMessage[] = [
        { role: 'system', content: openAISystemPrompt(task, [...tools.keys()]) },
        { role: 'user', content: task.prompt },
      ]
      const ctx: ToolContext = { dir, signal }
      let usage: AgentUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }
      let reported: number | undefined
      let retriedOutput = false

      for (let turn = 1; turn <= maxTurns; turn++) {
        // oxlint-disable-next-line no-await-in-loop -- every turn depends on the previous answer
        const response = await doFetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            messages,
            ...(definitions.length ? { tools: definitions, tool_choice: 'auto' } : {}),
            ...(task.output && options.jsonMode
              ? { response_format: { type: 'json_object' } }
              : {}),
          }),
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
          ]),
        })
        signal.throwIfAborted()
        if (!response.ok) {
          // oxlint-disable-next-line no-await-in-loop -- error path
          const body = (await response.text().catch(() => '')).slice(0, 500)
          throw new Error(
            `openai-compatible agent failed (HTTP ${response.status})${body ? `: ${body}` : ''}`,
          )
        }
        // oxlint-disable-next-line no-await-in-loop -- see above
        const parsed = completionSchema.safeParse(await response.json())
        if (!parsed.success) throw new Error('openai-compatible agent got an invalid response')
        const added = addUsage(usage, parsed.data.usage)
        usage = added.usage
        if (added.cost !== undefined) reported = (reported ?? 0) + added.cost
        const message = parsed.data.choices[0]?.message
        const calls: ToolCall[] = (message?.tool_calls ?? []).map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.function.name, arguments: call.function.arguments ?? '' },
        }))

        if (calls.length) {
          messages.push({ role: 'assistant', content: message?.content ?? null, tool_calls: calls })
          for (const call of calls) {
            // oxlint-disable-next-line no-await-in-loop -- tools may edit the same files; run in order
            const content = await callTool(tools, call, ctx, maxChars)
            signal.throwIfAborted()
            messages.push({ role: 'tool', tool_call_id: call.id, content })
          }
          continue
        }

        const text = message?.content ?? ''
        const result: AgentResult<Output> = { text, turns: turn, usage }
        const cost = reported ?? costFromPricing(usage, options.pricing, model, logical)
        if (cost !== undefined) result.costUsd = cost
        if (!task.output) return result
        try {
          result.output = parseAgentOutput(text, task.output)
          return result
        } catch (error) {
          if (retriedOutput || turn === maxTurns || !(error instanceof AgentOutputError))
            throw error
          retriedOutput = true
          messages.push(
            { role: 'assistant', content: text },
            {
              role: 'user',
              content: `${error.message}. Answer again with only the JSON value.`,
            },
          )
        }
      }
      throw new Error(
        `openai-compatible agent failed (error_max_turns): no answer within ${maxTurns} turns`,
      )
    },
  }
}

/**
 * An `Agent` for any Chat Completions API with tool calling (OpenAI, Azure OpenAI, LiteLLM,
 * vLLM, corporate proxies to GPT, Gemini, Llama, ...). It runs a bounded tool loop itself: the
 * capabilities' file tools confined to `task.dir` (see `localTools`), `run_command` through the
 * injected `runner`, and every `task.toolsets` tool. `task.mcpServers` are not mounted. Usage
 * comes from the responses; cost from a reported `usage.cost`, else from `pricing`.
 */
export function openAICompatibleAgent(options: OpenAICompatibleAgentOptions): Agent {
  return createOpenAICompatibleAgent(options)
}
