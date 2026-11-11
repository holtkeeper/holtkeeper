import type { AgentTool, ToolContext, Toolset } from '@holtkeeper/agent'
import type { z } from 'zod'

/**
 * A tool of the registry: an `AgentTool` that internal agents mount in-process and the server's
 * MCP endpoint exposes under the same name and input schema.
 */
export interface RegistryTool<Input extends z.ZodObject = z.ZodObject> extends AgentTool<Input> {
  /** `false` for tools that write (e.g. propose an entry); MCP clients see it as `readOnlyHint`. Default `true`. */
  readOnly?: boolean
  /** What a call is about (a package, a repository), for usage statistics. */
  subject?(input: z.infer<Input>): string | undefined
  /** Hits returned when `limit` is not passed; result caps clamp it like an explicit `limit`. */
  defaultLimit?: number
}

/** A toolset of the registry. `instructions` is a sentence or two on when to use its tools. */
export interface RegistryToolset extends Toolset {
  tools: RegistryTool[]
  instructions?: string
}

/** A tool failure whose message is meant for the agent as it is. */
export class ToolError extends Error {}

/** Declares a tool with its input type inferred from the schema. */
export function defineTool<Input extends z.ZodObject>(tool: {
  name: string
  description: string
  input: Input
  run(input: z.infer<Input>, ctx: ToolContext): Promise<string> | string
  readOnly?: boolean
  subject?(input: z.infer<Input>): string | undefined
  defaultLimit?: number
}): RegistryTool {
  return tool
}
