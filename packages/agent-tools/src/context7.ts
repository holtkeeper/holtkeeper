import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'

/** Server name Context7 is mounted under; its tools become `mcp__context7__<tool>`. */
export const CONTEXT7_SERVER = 'context7'

/** Context7's hosted MCP endpoint (streamable HTTP). */
export const CONTEXT7_URL = 'https://mcp.context7.com/mcp'

/** npm package of the local Context7 MCP server. */
export const CONTEXT7_PACKAGE = '@upstash/context7-mcp'

export interface Context7Options {
  /** `remote` (default) talks to `CONTEXT7_URL`; `stdio` runs the server with `npx`. */
  transport?: 'remote' | 'stdio'
  /** Optional Context7 API key for higher rate limits. */
  apiKey?: string
}

/**
 * The SDK `mcpServers` entry for Context7, an external service with up-to-date library docs
 * (`resolve-library-id`, `query-docs`). Its tools are always loaded so the model sees them
 * without a tool search.
 */
export function context7Server(options: Context7Options = {}): Record<string, McpServerConfig> {
  if (options.transport === 'stdio') {
    return {
      [CONTEXT7_SERVER]: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', CONTEXT7_PACKAGE, ...(options.apiKey ? ['--api-key', options.apiKey] : [])],
        alwaysLoad: true,
      },
    }
  }
  return {
    [CONTEXT7_SERVER]: {
      type: 'http',
      url: CONTEXT7_URL,
      ...(options.apiKey ? { headers: { Authorization: `Bearer ${options.apiKey}` } } : {}),
      alwaysLoad: true,
    },
  }
}

/** Tool settings as stored under `agent.tools`. */
export interface AgentToolSettings {
  context7?: boolean
  maxResultLines?: number
}

/** External MCP servers enabled by settings; empty unless `context7` is true (it is off by default). */
export function externalServers(
  settings: AgentToolSettings = {},
  context7: Context7Options = {},
): Record<string, McpServerConfig> {
  return settings.context7 === true ? context7Server(context7) : {}
}
