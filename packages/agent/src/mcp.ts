import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk'

import type { AgentTool, ToolContext, Toolset } from './types.ts'

/** Name of the in-process MCP server that serves mounted toolsets. */
export const TOOLSET_SERVER = 'holtkeeper'

/** The MCP spelling of a tool name: characters outside `[A-Za-z0-9_-]` become `_`. */
export function mcpToolName(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9_-]/g, '_')
}

/** The name Claude Code gives a tool of an MCP server: `mcp__<server>__<tool>`. */
export function qualifiedToolName(server: string, tool: string): string {
  return `mcp__${mcpToolName(server)}__${mcpToolName(tool)}`
}

export interface MountedToolsets {
  name: string
  server: McpSdkServerConfigWithInstance
  /** Fully qualified names of every served tool, in toolset order. */
  allowedTools: string[]
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * An SDK MCP tool definition that runs `tool` with `ctx`: arguments are validated by the tool's
 * schema, and a thrown error becomes an `isError` result with the message.
 */
export function sdkTool(tool: AgentTool, ctx: ToolContext): SdkMcpToolDefinition {
  return {
    name: mcpToolName(tool.name),
    description: tool.description,
    inputSchema: tool.input.shape,
    handler: async (args: unknown) => {
      try {
        const text = await tool.run(tool.input.parse(args), ctx)
        return { content: [{ type: 'text' as const, text }] }
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `error: ${errorText(error)}` }],
          isError: true,
        }
      }
    },
  }
}

/**
 * Serves `toolsets` from an in-process SDK MCP server. Every tool runs with `ctx`; a tool that
 * throws answers the model with an error result instead of failing the task. Throws when two
 * tools share an MCP name.
 */
export function toMcpServer(
  toolsets: readonly Toolset[],
  ctx: ToolContext,
  name: string = TOOLSET_SERVER,
): MountedToolsets {
  const tools: AgentTool[] = toolsets.flatMap((toolset) => toolset.tools)
  const seen = new Set<string>()
  for (const tool of tools) {
    const mcpName = mcpToolName(tool.name)
    if (seen.has(mcpName)) throw new Error(`duplicate agent tool ${tool.name}`)
    seen.add(mcpName)
  }
  const server = createSdkMcpServer({
    name,
    alwaysLoad: true,
    tools: tools.map((tool) => sdkTool(tool, ctx)),
  })
  return { name, server, allowedTools: tools.map((tool) => qualifiedToolName(name, tool.name)) }
}
