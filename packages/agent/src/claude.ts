import { isAbsolute, resolve } from 'node:path'

import {
  type CanUseTool,
  type Options,
  query as sdkQuery,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { resolveSecret, type Secret } from '@holtkeeper/forge'

import { commandAllowed } from './commands.ts'
import { BudgetExceededError, budgetExceededFrom } from './errors.ts'
import { toMcpServer, mcpToolName, toolsetGuidance } from './mcp.ts'
import { parseAgentOutput, validateAgentOutput } from './output.ts'
import { isInside } from './paths.ts'
import { costFromPricing, mapModel, type ModelPricing } from './provider.ts'
import {
  DEFAULT_TIER,
  FALLBACK_TIER_MODELS,
  type ModelTier,
  TIERS,
  type TierModels,
} from './tiers.ts'
import type { TranscriptSink, TranscriptToolCall } from './transcript.ts'
import type { Agent, AgentCapability, AgentResult, AgentTask, AgentUsage } from './types.ts'

/**
 * Where Claude Code sends model requests. `anthropic` is the Anthropic API (optionally at another
 * `baseUrl`); `anthropic-compatible` is a gateway speaking the Messages API.
 */
export type ClaudeConnection =
  | { kind: 'anthropic'; baseUrl?: string }
  | {
      kind: 'anthropic-compatible'
      baseUrl: string
      authHeader?: 'x-api-key' | 'bearer'
      /** Sent with every request; values are final (no placeholders). */
      headers?: Record<string, string>
    }

export interface ClaudeAgentOptions {
  /** The provider secret: an Anthropic API key or gateway token. */
  apiKey: Secret
  /** Default: the Anthropic API. */
  connection?: ClaudeConnection
  /** Logical model id → the provider's name for it; applied after tier resolution. */
  modelMap?: Record<string, string>
  /** Prices per model; when the task's model has an entry, cost is computed from usage with it. */
  pricing?: Record<string, ModelPricing>
  /** Timeout of one model request. */
  timeoutMs?: number
  /** Model of each tier, e.g. from `resolveTierModels`. Default `FALLBACK_TIER_MODELS`. */
  tierModels?: TierModels
  /** Turn limit for tasks that do not set their own. */
  maxTurns?: number
  /** Claude Code binary to run instead of the one bundled with the SDK. */
  pathToClaudeCodeExecutable?: string
}

/** The SDK's `query()` as the adapter uses it; tests substitute a fake. */
export type ClaudeQuery = (params: {
  prompt: string
  options?: Options
}) => AsyncIterable<SDKMessage>

export interface ClaudeAgentDependencies {
  query: ClaudeQuery
}

/** Claude Code tools each capability unlocks. No other tool is ever available to the agent. */
export const CAPABILITY_TOOLS: Readonly<Record<AgentCapability, readonly string[]>> = {
  read: ['Read', 'Glob'],
  search: ['Grep'],
  run: ['Bash'],
  edit: ['Edit', 'Write'],
}

const DEFAULT_CAPABILITIES: readonly AgentCapability[] = ['read', 'search']

/** Host variables the agent process inherits; everything else (tokens, credentials) stays out. */
const INHERITED_ENV = ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM'] as const

const ANTHROPIC_API_HOST = 'api.anthropic.com'

const PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const

/** Tool names for a capability set, in a stable order without duplicates. */
export function toolsFor(capabilities: readonly AgentCapability[]): string[] {
  return [...new Set(capabilities.flatMap((capability) => CAPABILITY_TOOLS[capability]))]
}

/** The logical model a tier runs on: its entry in `tierModels`, else the tier's fallback. */
export function modelFor(
  options: { tierModels?: TierModels },
  tier: ModelTier = DEFAULT_TIER,
): string {
  return (options.tierModels ?? FALLBACK_TIER_MODELS)[tier]
}

/**
 * Allows only the granted tools (and tools of the given MCP server prefixes), only on paths
 * inside `dir`, and with `commands` only those Bash commands.
 */
function permissionGate(
  dir: string,
  tools: readonly string[],
  prefixes: readonly string[] = [],
  commands?: readonly string[],
): CanUseTool {
  const allowed = new Set(tools)
  return async (toolName, input) => {
    if (!allowed.has(toolName) && !prefixes.some((prefix) => toolName.startsWith(prefix)))
      return { behavior: 'deny', message: `${toolName} is not available for this task` }
    const command = input['command']
    if (
      toolName === 'Bash' &&
      commands &&
      (typeof command !== 'string' || !commandAllowed(command, commands))
    )
      return {
        behavior: 'deny',
        message: `Only these commands may run, with plain arguments: ${commands.join(', ')}`,
      }
    for (const key of PATH_KEYS) {
      const value = input[key]
      if (typeof value === 'string' && !isInside(dir, value)) {
        return { behavior: 'deny', message: `${value} is outside the working directory ${dir}` }
      }
    }
    const pattern = input['pattern']
    if (
      toolName === 'Glob' &&
      typeof pattern === 'string' &&
      isAbsolute(pattern) &&
      !isInside(dir, pattern)
    ) {
      return { behavior: 'deny', message: `${pattern} is outside the working directory ${dir}` }
    }
    return { behavior: 'allow', updatedInput: input }
  }
}

/**
 * System prompt additions: task instructions, the context block, confinement, tool limits, the
 * mounted toolsets' `instructions` and the answer format. Nothing in it depends on the run (the checkout path reaches the model through
 * Claude Code's dynamic section), so runs of the same kind share a cacheable system prompt.
 * `extraTools` are the mounted MCP tools the model should prefer over reading whole files.
 */
export function systemPromptFor(
  task: AgentTask,
  _dir: string,
  tools: readonly string[],
  extraTools: readonly string[] = [],
): string {
  const parts: string[] = []
  if (task.system) parts.push(task.system.trim())
  if (task.context?.trim()) parts.push(task.context.trim())
  const external = Object.keys(task.mcpServers ?? {})
  parts.push(
    [
      'You work in the repository checkout that is your working directory. Do not read, write or run anything outside it.',
      `Available tools: ${[...tools, ...extraTools].join(', ')}${external.length ? `, and the tools of the MCP servers ${external.join(', ')}` : ''}. Do not ask for other tools or for user input; nobody will answer.`,
      extraTools.length
        ? 'Prefer the mcp__ tools over reading whole files: outline a file or search before reading, then read only the line ranges you need. Their results are already trimmed; narrow the query instead of asking for more.'
        : '',
      tools.includes('Edit') ? '' : 'Do not modify files.',
    ]
      .filter(Boolean)
      .join('\n'),
  )
  const guidance = toolsetGuidance(task.toolsets)
  if (guidance) parts.push(guidance)
  if (task.output) {
    parts.push(
      'Your final message must be a single JSON value matching the format the task describes, with no prose around it. A ```json fence is acceptable.',
    )
  }
  return parts.join('\n\n')
}

/** Abort controller that follows `signal`, so cancelling the task stops the Claude Code process. */
function linkedController(signal: AbortSignal | undefined): AbortController {
  const controller = new AbortController()
  if (signal?.aborted) controller.abort(signal.reason)
  else signal?.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  return controller
}

function inherit(names: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of names) {
    const value = process.env[name]
    if (value) env[name] = value
  }
  return env
}

/**
 * The Claude Code process environment for `options`: the inherited basics plus exactly the
 * provider variables the connection needs. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` makes Claude Code
 * strip provider credentials from the environment of Bash and other subprocesses, so tools never
 * see them.
 */
export function claudeEnv(options: ClaudeAgentOptions): Record<string, string> {
  const connection = options.connection ?? { kind: 'anthropic' }
  const env: Record<string, string> = {
    ...inherit(INHERITED_ENV),
    CLAUDE_AGENT_SDK_CLIENT_APP: 'holtkeeper',
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  }
  if (options.timeoutMs !== undefined) env['API_TIMEOUT_MS'] = String(options.timeoutMs)
  env['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = mapModel(modelFor(options, 'fast'), options.modelMap)
  const secret = resolveSecret(options.apiKey)
  switch (connection.kind) {
    case 'anthropic': {
      env['ANTHROPIC_API_KEY'] = secret
      if (connection.baseUrl && new URL(connection.baseUrl).host !== ANTHROPIC_API_HOST)
        env['ANTHROPIC_BASE_URL'] = connection.baseUrl
      break
    }
    case 'anthropic-compatible': {
      env['ANTHROPIC_BASE_URL'] = connection.baseUrl
      if (connection.authHeader === 'bearer') env['ANTHROPIC_AUTH_TOKEN'] = secret
      else env['ANTHROPIC_API_KEY'] = secret
      const headers = Object.entries(connection.headers ?? {})
      if (headers.length)
        env['ANTHROPIC_CUSTOM_HEADERS'] = headers
          .map(([name, value]) => `${name}: ${value}`)
          .join('\n')
      env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] = '1'
      break
    }
  }
  return env
}

/** SDK options for one task; exposed so the mapping is testable without running Claude Code. */
export function claudeOptionsFor(
  options: ClaudeAgentOptions,
  task: AgentTask,
  abortController: AbortController,
): Options {
  const dir = resolve(task.dir)
  const capabilities = task.capabilities ?? DEFAULT_CAPABILITIES
  const tools = toolsFor(capabilities)
  const maxTurns = task.maxTurns ?? options.maxTurns
  const mounted = task.toolsets?.length
    ? toMcpServer(task.toolsets, { dir, signal: abortController.signal })
    : undefined
  const external = task.mcpServers ?? {}
  if (mounted && mounted.name in external)
    throw new Error(`MCP server name ${mounted.name} is reserved for toolsets`)
  const mcpTools = mounted?.allowedTools ?? []
  const prefixes = Object.keys(external).map((name) => `mcp__${mcpToolName(name)}__`)
  const tier = task.tier ?? DEFAULT_TIER
  return {
    cwd: dir,
    model: mapModel(modelFor(options, tier), options.modelMap),
    effort: TIERS[tier].effort,
    tools,
    allowedTools: [...mcpTools],
    canUseTool: permissionGate(dir, [...tools, ...mcpTools], prefixes, task.commands),
    permissionMode: 'default',
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: systemPromptFor(task, dir, tools, mcpTools),
      excludeDynamicSections: true,
    },
    // Isolation: no user/project settings, hooks, host MCP servers or CLAUDE.md; only the task's.
    settingSources: [],
    mcpServers: { ...external, ...(mounted ? { [mounted.name]: mounted.server } : {}) },
    strictMcpConfig: true,
    persistSession: false,
    env: { ...task.env, ...claudeEnv(options) },
    abortController,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(task.maxCostUsd !== undefined ? { maxBudgetUsd: task.maxCostUsd } : {}),
    ...(options.pathToClaudeCodeExecutable
      ? { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable }
      : {}),
    ...(capabilities.includes('run')
      ? { sandbox: { enabled: true, allowUnsandboxedCommands: false } }
      : {}),
  }
}

type ResultMessage = Extract<SDKMessage, { type: 'result' }>

/** Token counts summed over the models in `modelUsage`, or the main loop's `usage` without it. */
export function usageOf(result: ResultMessage): AgentUsage | undefined {
  const models = Object.values(result.modelUsage ?? {})
  if (models.length > 0) {
    return models.reduce<AgentUsage>(
      (sum, model) => ({
        inputTokens: sum.inputTokens + model.inputTokens,
        outputTokens: sum.outputTokens + model.outputTokens,
        cacheReadTokens: sum.cacheReadTokens + model.cacheReadInputTokens,
        cacheWriteTokens: sum.cacheWriteTokens + model.cacheCreationInputTokens,
      }),
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    )
  }
  const usage = result.usage as Partial<ResultMessage['usage']> | undefined
  if (!usage) return undefined
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const blocksOf = (value: unknown): Record<string, unknown>[] =>
  isRecord(value) && Array.isArray(value['content']) ? value['content'].filter(isRecord) : []

const resultText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter(isRecord)
          .map((part) =>
            typeof part['text'] === 'string' ? part['text'] : `[${String(part['type'])}]`,
          )
          .join('\n')
      : ''

/** Writes the model text, tool calls and tool results of one SDK message to `sink`. */
export function transcribeSdkMessage(message: SDKMessage, sink: TranscriptSink): void {
  if (message.type === 'assistant') {
    const blocks = blocksOf(message.message)
    const text = blocks
      .flatMap((block) =>
        block['type'] === 'text' && typeof block['text'] === 'string' ? [block['text']] : [],
      )
      .join('\n')
    const toolCalls = blocks.flatMap((block): TranscriptToolCall[] =>
      block['type'] === 'tool_use'
        ? [{ id: String(block['id']), name: String(block['name']), input: block['input'] }]
        : [],
    )
    if (text || toolCalls.length)
      sink.write({
        type: 'assistant',
        ...(text && { text }),
        ...(toolCalls.length && { toolCalls }),
      })
    return
  }
  if (message.type === 'user') {
    for (const block of blocksOf(message.message)) {
      if (block['type'] !== 'tool_result') continue
      sink.write({
        type: 'tool-result',
        id: String(block['tool_use_id']),
        output: resultText(block['content']),
        ...(block['is_error'] === true && { isError: true }),
      })
    }
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * `claudeAgent` with an injectable `query`, so tests can drive the adapter with scripted SDK
 * messages instead of a real Claude Code process.
 */
export function createClaudeAgent(
  options: ClaudeAgentOptions,
  { query }: ClaudeAgentDependencies,
): Agent {
  const agent: Agent = {
    name: 'claude',
    async run<Output>(task: AgentTask<Output>): Promise<AgentResult<Output>> {
      task.signal?.throwIfAborted()
      const controller = linkedController(task.signal)
      const sdkOptions = claudeOptionsFor(options, task, controller)
      const sink = task.transcript
      const preset = sdkOptions.systemPrompt
      const system =
        typeof preset === 'object' && !Array.isArray(preset) && preset.type === 'preset'
          ? preset.append
          : undefined
      sink?.write({
        type: 'start',
        runtime: 'claude-sdk',
        model: sdkOptions.model ?? '',
        tier: task.tier ?? DEFAULT_TIER,
        ...(task.taskKind && { taskKind: task.taskKind }),
        tools: [
          ...(Array.isArray(sdkOptions.tools) ? sdkOptions.tools : []),
          ...(sdkOptions.allowedTools ?? []),
        ],
        ...(system && { system }),
        prompt: task.prompt,
      })
      try {
        const result = await runQuery<Output>(task, sdkOptions, sink)
        sink?.write({
          type: 'end',
          outcome: 'ok',
          turns: result.turns,
          ...(result.usage && { usage: result.usage }),
          ...(result.costUsd !== undefined && { costUsd: result.costUsd }),
        })
        return result
      } catch (error) {
        sink?.write({
          type: 'end',
          outcome: 'error',
          error: messageOf(error),
          ...(error instanceof BudgetExceededError && {
            ...(error.turns !== undefined && { turns: error.turns }),
            ...(error.usage && { usage: error.usage }),
            ...(error.costUsd !== undefined && { costUsd: error.costUsd }),
          }),
        })
        throw error
      }
    },
  }
  return agent

  async function runQuery<Output>(
    task: AgentTask<Output>,
    sdkOptions: Options,
    sink: TranscriptSink | undefined,
  ): Promise<AgentResult<Output>> {
    let last: ResultMessage | undefined
    for await (const message of query({ prompt: task.prompt, options: sdkOptions })) {
      if (message.type === 'result') last = message
      else if (sink) transcribeSdkMessage(message, sink)
    }
    task.signal?.throwIfAborted()
    if (!last) throw new Error('claude agent finished without a result')
    if (last.subtype === 'error_max_budget_usd') {
      const usage = usageOf(last)
      throw new BudgetExceededError(
        `AI budget exceeded: the run spent $${last.total_cost_usd.toFixed(2)} of its $${task.maxCostUsd?.toFixed(2) ?? '?'} cap`,
        { costUsd: last.total_cost_usd, turns: last.num_turns, ...(usage && { usage }) },
      )
    }
    if (last.subtype !== 'success' || last.is_error) {
      const detail = last.subtype === 'success' ? last.result : last.errors.join('; ')
      const failure = new Error(
        `claude agent failed (${last.subtype})${detail ? `: ${detail}` : ''}`,
      )
      throw budgetExceededFrom(failure) ?? failure
    }

    const logical = modelFor(options, task.tier)
    const model = mapModel(logical, options.modelMap)
    const result: AgentResult<Output> = {
      text: last.result,
      turns: last.num_turns,
      costUsd: last.total_cost_usd,
      model,
      runtime: 'claude-sdk',
    }
    const usage = usageOf(last)
    if (usage) {
      result.usage = usage
      const priced = costFromPricing(usage, options.pricing, model, logical)
      if (priced !== undefined) result.costUsd = priced
    }
    if (task.output) {
      result.output =
        last.structured_output === undefined
          ? parseAgentOutput(last.result, task.output)
          : validateAgentOutput(last.structured_output, task.output, last.result)
    }
    return result
  }
}

/**
 * An `Agent` backed by Claude Code through the Claude Agent SDK. It works only inside
 * `task.dir`, gets only the tools its capabilities map to (`CAPABILITY_TOOLS`) plus the task's
 * toolsets and MCP servers, runs without host settings or MCP servers, runs `task.tier`'s model
 * (then `modelMap`) at the tier's effort, and sandboxes shell commands when `run` is granted. The
 * secret is resolved per task and passed to the Claude Code process only, as the variables of
 * `options.connection` (see `claudeEnv`); its subprocesses do not inherit it.
 */
export function claudeAgent(options: ClaudeAgentOptions): Agent {
  return createClaudeAgent(options, { query: sdkQuery })
}
