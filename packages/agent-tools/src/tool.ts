import type { AgentTool, ToolContext } from '@holtkeeper/agent'
import type { z } from 'zod'

/** Declares a tool with its input type inferred from the schema. */
export function defineTool<Input extends z.ZodObject>(tool: {
  name: string
  description: string
  input: Input
  run(input: z.infer<Input>, ctx: ToolContext): Promise<string> | string
}): AgentTool {
  return tool
}
