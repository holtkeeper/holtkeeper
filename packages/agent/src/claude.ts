import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import {
  type CanUseTool,
  type Options,
  query as sdkQuery,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { resolveSecret, type Secret } from '@holtkeeper/forge'

import { toMcpServer, mcpToolName } from './mcp.ts'
import { parseAgentOutput, validateAgentOutput } from './output.ts'
import { isInside } from './paths.ts'
import { costFromPricing, mapModel, type ModelPricing } from './provider.ts'
import type { Agent, AgentCapability, AgentResult, AgentTask, AgentUsage } from './types.ts'

/** Model used when neither `ClaudeAgentOptions.models` nor `model` picks one. */
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5'

/** Model for `taskKind: 'triage'` when `ClaudeAgentOptions.models` has no `triage` entry. */
export const DEFAULT_TRIAGE_MODEL = 'claude-haiku-5-5'

/**
 * Where Claude Code sends model requests. `anthropic` is the Anthropic API (optionally at another
 * `baseUrl`); `anthropic-compatible` is a gateway speaking the Messages API; `bedrock` and
 * `vertex` are the cloud platforms, with credentials from the server environment or the secret.
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
  | { kind: 'bedrock'; region: string; baseUrl?: string; credentials?: 'env' | 'secret' }
  | {
      kind: 'vertex'
      region: string
      projectId: string
      baseUrl?: string
      credentials?: 'env' | 'secret'
    }

/** Model selection shared by the adapters: a default model and models per task kind. */
export interface ModelRouting {
  model?: string
  models?: Record<string, string>
}

export interface ClaudeAgentOptions {
  /**
   * The provider secret: an Anthropic API key or gateway token, a Bedrock API key or AWS key JSON,
   * or a Google service account key JSON. Optional only for cloud connections with `env` credentials.
   */
  apiKey?: Secret
  /** Default: the Anthropic API. */
  connection?: ClaudeConnection
  /** Logical model id → the provider's name for it; applied after routing. */
  modelMap?: Record<string, string>
  /** Prices per model; when the task's model has an entry, cost is computed from usage with it. */
  pricing?: Record<string, ModelPricing>
  /** Timeout of one model request. */
  timeoutMs?: number
  /** Default `DEFAULT_CLAUDE_MODEL`. */
  model?: string
  /**
   * Model per task kind (`AgentTask.taskKind`), e.g. `{ review: 'claude-opus-5-5' }`. A kind
   * without an entry uses `model`; `triage` falls back to `DEFAULT_TRIAGE_MODEL` instead.
   */
  models?: Record<string, string>
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

/** Host variables a Bedrock connection with `env` credentials inherits. */
const AWS_ENV = [
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
] as const

/** Host variables a Vertex connection with `env` credentials inherits. */
const GOOGLE_ENV = [
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'CLOUDSDK_CONFIG',
] as const

const ANTHROPIC_API_HOST = 'api.anthropic.com'

const PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const

/** Tool names for a capability set, in a stable order without duplicates. */
export function toolsFor(capabilities: readonly AgentCapability[]): string[] {
  return [...new Set(capabilities.flatMap((capability) => CAPABILITY_TOOLS[capability]))]
}

/** The model a task runs on: its kind's entry in `models`, then `model`, then the defaults. */
export function modelFor(options: ModelRouting, taskKind?: string): string {
  const routed = taskKind === undefined ? undefined : options.models?.[taskKind]
  if (routed) return routed
  if (taskKind === 'triage') return DEFAULT_TRIAGE_MODEL
  return options.model ?? DEFAULT_CLAUDE_MODEL
}

/**
 * Allows only the granted tools (and tools of the given MCP server prefixes), and only on paths
 * inside `dir`.
 */
function permissionGate(
  dir: string,
  tools: readonly string[],
  prefixes: readonly string[] = [],
): CanUseTool {
  const allowed = new Set(tools)
  return async (toolName, input) => {
    if (!allowed.has(toolName) && !prefixes.some((prefix) => toolName.startsWith(prefix)))
      return { behavior: 'deny', message: `${toolName} is not available for this task` }
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
 * System prompt additions: task instructions, the context block, confinement, tool limits and the
 * answer format. Nothing in it depends on the run (the checkout path reaches the model through
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

function secretOf(options: ClaudeAgentOptions): string {
  if (options.apiKey === undefined)
    throw new Error('claude agent needs an apiKey for this connection')
  return resolveSecret(options.apiKey)
}

function awsSecretEnv(secret: string): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(secret)
  } catch {
    return { AWS_BEARER_TOKEN_BEDROCK: secret }
  }
  const field = (name: string) => {
    const value: unknown =
      typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, name) : undefined
    return typeof value === 'string' && value ? value : undefined
  }
  const accessKeyId = field('accessKeyId')
  const secretAccessKey = field('secretAccessKey')
  if (!accessKeyId || !secretAccessKey)
    throw new Error(
      'bedrock secret must be an API key or JSON with accessKeyId and secretAccessKey',
    )
  const sessionToken = field('sessionToken')
  return {
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
    ...(sessionToken ? { AWS_SESSION_TOKEN: sessionToken } : {}),
  }
}

/** Files a run prepares outside the checkout, e.g. a Vertex service account key. */
export interface ClaudeRunFiles {
  googleCredentialsFile?: string
}

/**
 * The Claude Code process environment for `options`: the inherited basics plus exactly the
 * provider variables the connection needs. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` makes Claude Code
 * strip provider credentials from the environment of Bash and other subprocesses, so tools never
 * see them.
 */
export function claudeEnv(
  options: ClaudeAgentOptions,
  files: ClaudeRunFiles = {},
): Record<string, string> {
  const connection = options.connection ?? { kind: 'anthropic' }
  const env: Record<string, string> = {
    ...inherit(INHERITED_ENV),
    CLAUDE_AGENT_SDK_CLIENT_APP: 'holtkeeper',
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
  }
  if (options.timeoutMs !== undefined) env['API_TIMEOUT_MS'] = String(options.timeoutMs)
  const haiku = options.modelMap?.[DEFAULT_TRIAGE_MODEL]
  if (haiku) env['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = haiku
  switch (connection.kind) {
    case 'anthropic': {
      env['ANTHROPIC_API_KEY'] = secretOf(options)
      if (connection.baseUrl && new URL(connection.baseUrl).host !== ANTHROPIC_API_HOST)
        env['ANTHROPIC_BASE_URL'] = connection.baseUrl
      break
    }
    case 'anthropic-compatible': {
      const secret = secretOf(options)
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
    case 'bedrock': {
      Object.assign(
        env,
        connection.credentials === 'secret' ? awsSecretEnv(secretOf(options)) : inherit(AWS_ENV),
      )
      env['CLAUDE_CODE_USE_BEDROCK'] = '1'
      env['AWS_REGION'] = connection.region
      if (connection.baseUrl) env['ANTHROPIC_BEDROCK_BASE_URL'] = connection.baseUrl
      env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] = '1'
      break
    }
    case 'vertex': {
      if (connection.credentials === 'secret') {
        if (!files.googleCredentialsFile)
          throw new Error('vertex secret credentials need a prepared key file')
        env['GOOGLE_APPLICATION_CREDENTIALS'] = files.googleCredentialsFile
      } else Object.assign(env, inherit(GOOGLE_ENV))
      env['CLAUDE_CODE_USE_VERTEX'] = '1'
      env['CLOUD_ML_REGION'] = connection.region
      env['ANTHROPIC_VERTEX_PROJECT_ID'] = connection.projectId
      if (connection.baseUrl) env['ANTHROPIC_VERTEX_BASE_URL'] = connection.baseUrl
      env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] = '1'
      break
    }
  }
  return env
}

/** Writes what `claudeEnv` needs on disk for one run; `cleanup` removes it. */
async function prepareFiles(
  options: ClaudeAgentOptions,
): Promise<{ files: ClaudeRunFiles; cleanup: () => Promise<void> }> {
  const connection = options.connection
  if (connection?.kind !== 'vertex' || connection.credentials !== 'secret')
    return { files: {}, cleanup: async () => {} }
  const dir = await mkdtemp(join(tmpdir(), 'holtkeeper-vertex-'))
  const file = join(dir, 'credentials.json')
  await writeFile(file, secretOf(options), { mode: 0o600 })
  await chmod(dir, 0o700)
  return {
    files: { googleCredentialsFile: file },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

/** SDK options for one task; exposed so the mapping is testable without running Claude Code. */
export function claudeOptionsFor(
  options: ClaudeAgentOptions,
  task: AgentTask,
  abortController: AbortController,
  files: ClaudeRunFiles = {},
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
  return {
    cwd: dir,
    model: mapModel(modelFor(options, task.taskKind), options.modelMap),
    tools,
    allowedTools: [...mcpTools],
    canUseTool: permissionGate(dir, [...tools, ...mcpTools], prefixes),
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
    env: claudeEnv(options, files),
    abortController,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
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

/**
 * `claudeAgent` with an injectable `query`, so tests can drive the adapter with scripted SDK
 * messages instead of a real Claude Code process.
 */
export function createClaudeAgent(
  options: ClaudeAgentOptions,
  { query }: ClaudeAgentDependencies,
): Agent {
  return {
    name: 'claude',
    async run<Output>(task: AgentTask<Output>): Promise<AgentResult<Output>> {
      task.signal?.throwIfAborted()
      const controller = linkedController(task.signal)
      const prepared = await prepareFiles(options)
      let last: ResultMessage | undefined
      try {
        const sdkOptions = claudeOptionsFor(options, task, controller, prepared.files)
        for await (const message of query({ prompt: task.prompt, options: sdkOptions })) {
          if (message.type === 'result') last = message
        }
      } finally {
        await prepared.cleanup()
      }
      task.signal?.throwIfAborted()
      if (!last) throw new Error('claude agent finished without a result')
      if (last.subtype !== 'success' || last.is_error) {
        const detail = last.subtype === 'success' ? last.result : last.errors.join('; ')
        throw new Error(`claude agent failed (${last.subtype})${detail ? `: ${detail}` : ''}`)
      }

      const result: AgentResult<Output> = {
        text: last.result,
        turns: last.num_turns,
        costUsd: last.total_cost_usd,
      }
      const usage = usageOf(last)
      if (usage) {
        result.usage = usage
        const logical = modelFor(options, task.taskKind)
        const priced = costFromPricing(
          usage,
          options.pricing,
          mapModel(logical, options.modelMap),
          logical,
        )
        if (priced !== undefined) result.costUsd = priced
      }
      if (task.output) {
        result.output =
          last.structured_output === undefined
            ? parseAgentOutput(last.result, task.output)
            : validateAgentOutput(last.structured_output, task.output, last.result)
      }
      return result
    },
  }
}

/**
 * An `Agent` backed by Claude Code through the Claude Agent SDK. It works only inside
 * `task.dir`, gets only the tools its capabilities map to (`CAPABILITY_TOOLS`) plus the task's
 * toolsets and MCP servers, runs without host settings or MCP servers, routes the model by
 * `task.taskKind` (then `modelMap`), and sandboxes shell commands when `run` is granted. The
 * secret is resolved per task and passed to the Claude Code process only, as the variables of
 * `options.connection` (see `claudeEnv`); its subprocesses do not inherit it.
 */
export function claudeAgent(options: ClaudeAgentOptions): Agent {
  return createClaudeAgent(options, { query: sdkQuery })
}
