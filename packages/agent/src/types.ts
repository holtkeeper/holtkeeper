import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { z } from 'zod'

import type { ModelTier } from './tiers.ts'
import type { AgentRuntime, TranscriptSink } from './transcript.ts'

/** What the agent may do in the checkout. */
export type AgentCapability = 'read' | 'search' | 'run' | 'edit'

export interface AgentTask<Output = unknown> {
  /** Checkout the agent works in; it must not touch anything outside. */
  dir: string
  prompt: string
  system?: string
  /** Default `['read', 'search']`. */
  capabilities?: AgentCapability[]
  /** When given, the agent must answer with JSON matching it; the result carries it parsed. */
  output?: z.ZodType<Output>
  /**
   * With `run`: the only commands the agent may run (`commandAllowed`), each exactly or followed
   * by plain arguments; shell operators are refused. Absent: any command.
   */
  commands?: readonly string[]
  /**
   * Variables the agent's commands get on top of the adapter's minimal environment, e.g. the
   * egress proxy. Never put secrets here.
   */
  env?: Record<string, string>
  maxTurns?: number
  /**
   * Spend cap of the run in USD. Once the run's cost reaches it, the agent stops and fails with
   * `BudgetExceededError` carrying what the run used. Adapters that cannot price a run ignore it.
   */
  maxCostUsd?: number
  signal?: AbortSignal
  /**
   * Model tier the task runs on (`fast`, `main`, `deep`), with the tier's reasoning effort.
   * Default `DEFAULT_TIER` (`main`). Callers never name a model.
   */
  tier?: ModelTier
  /**
   * What kind of work this is (`review`, `refactor`, `triage`, ...), for knowledge, instructions
   * and reporting. It never changes the model or what the agent may do.
   */
  taskKind?: string
  /**
   * A pre-selected knowledge and conventions block. Adapters place it early in the system prompt,
   * before anything run-specific, so repeated runs share a cacheable prefix.
   */
  context?: string
  /** In-process tools mounted for this task; their tools are allowed in addition to `capabilities`. */
  toolsets?: readonly Toolset[]
  /** External MCP servers by name. Every tool of a listed server is allowed; no other server is loaded. */
  mcpServers?: Record<string, McpServerConfig>
  /**
   * Receives the run's events: its start, every model message and tool call, tool results and
   * the outcome with usage and cost. Adapters never write their options, environment or secrets.
   */
  transcript?: TranscriptSink
}

/** Token counts of one run, summed over every model the run used. */
export interface AgentUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface AgentResult<Output = unknown> {
  /** Final answer text. */
  text: string
  output?: Output
  /**
   * Model requests the run made. An adapter that asks for a final answer after its turn limit
   * counts that request too, so this can exceed the limit by one.
   */
  turns: number
  costUsd?: number
  usage?: AgentUsage
  /** The provider's id of the model the run used, when the adapter knows it. */
  model?: string
  /** The loop that ran the task. */
  runtime?: AgentRuntime
  /** Where the run's transcript was stored (an artifact id), when the caller stored one. */
  transcriptRef?: string
}

/** What a tool may use while it runs: the checkout it is confined to and the task's abort signal. */
export interface ToolContext {
  /** Absolute checkout directory; tools must not read or write outside it. */
  dir: string
  signal: AbortSignal
}

/**
 * A tool the agent can call. `run` returns compact text meant for the model: it stays within the
 * tool's output budget and marks truncation instead of dumping whole files. Throwing reports an
 * error to the model; it does not fail the task.
 */
export interface AgentTool<Input extends z.ZodObject = z.ZodObject> {
  /** Dotted name, unique across mounted toolsets, e.g. `code.search`. */
  name: string
  description: string
  /** Arguments schema; the model sees it as the tool's JSON schema. */
  input: Input
  run(input: z.infer<Input>, ctx: ToolContext): Promise<string> | string
}

/**
 * A named group of tools that is mounted together, e.g. `code` or `docs`. `instructions`, a
 * sentence or two on when to use its tools, reaches the model in the system prompt.
 */
export interface Toolset {
  name: string
  tools: AgentTool[]
  instructions?: string
}

/**
 * An LLM agent that works on a repository checkout: code review, refactoring for breaking
 * changes, writing tests. Callers depend on this interface only; the provider is configuration.
 */
export interface Agent {
  readonly name: string
  run<Output>(task: AgentTask<Output>): Promise<AgentResult<Output>>
}
