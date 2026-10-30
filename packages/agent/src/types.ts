import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { z } from 'zod'

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
  maxTurns?: number
  signal?: AbortSignal
  /**
   * What kind of work this is (`review`, `refactor`, `triage`, ...). Adapters pick the model by it;
   * it never changes what the agent may do.
   */
  taskKind?: string
  /**
   * A pre-selected knowledge and conventions block. Adapters place it early in the system prompt,
   * before anything run-specific, so repeated runs share a cacheable prefix.
   */
  context?: string
  /** In-process tools mounted for this task; their tools are allowed in addition to `capabilities`. */
  toolsets?: readonly Toolset[]
  /**
   * External MCP servers by name (e.g. Context7). Every tool of a listed server is allowed; no
   * other server is loaded.
   */
  mcpServers?: Record<string, McpServerConfig>
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
  turns: number
  costUsd?: number
  usage?: AgentUsage
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

/** A named group of tools that is mounted together, e.g. `code` or `docs`. */
export interface Toolset {
  name: string
  tools: AgentTool[]
}

/**
 * An LLM agent that works on a repository checkout: code review, refactoring for breaking
 * changes, writing tests. Callers depend on this interface only; the provider is configuration.
 */
export interface Agent {
  readonly name: string
  run<Output>(task: AgentTask<Output>): Promise<AgentResult<Output>>
}
