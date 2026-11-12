import type { Principal } from '@holtkeeper/access'
import { type RegistryToolset, ToolError, capText } from '@holtkeeper/agent-tools'
import type { ForbiddenError } from '@holtkeeper/api'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { z } from 'zod'

import { ForbiddenException, ForbiddenToolError } from '../context.ts'
import { type McpToolsetsContext, mcpToolsets } from '../tools/registry.ts'
import type { McpUsage } from './usage.ts'

/** Longest text a tool returns over MCP; agents get a hint to narrow the request instead. */
const maxText = 80_000

const narrowHint =
  'pass `subpath`, `docs: false` or use search_symbols / get_symbol for single names'

const text = (value: string) => ({
  content: [{ type: 'text' as const, text: capText(value, maxText, narrowHint) }],
})

/** Who calls the MCP endpoint, for usage statistics. */
export interface McpCaller {
  principal: Principal
  /** Id of the MCP token the request authenticated with. */
  token?: string
  /** First word of the client's User-Agent. */
  client?: string
  usage: Pick<McpUsage, 'record'>
  now: () => Date
}

/**
 * An MCP server serving `toolsets`: every tool under its own name and input schema, annotated
 * read-only unless it writes, with server instructions joined from the toolsets. A `ToolError`
 * reaches the client as it is, other failures as `Failed: <message>`; a missing permission
 * (`ForbiddenToolError`, `ForbiddenException`) also carries the `ForbiddenError` body as
 * `structuredContent`. Every call is recorded in `caller.usage`.
 */
export function registryServer(toolsets: readonly RegistryToolset[], caller: McpCaller): McpServer {
  const server = new McpServer(
    { name: 'holtkeeper', version: '1.0.0' },
    {
      instructions: toolsets
        .flatMap((toolset) => (toolset.instructions ? [toolset.instructions] : []))
        .join(' '),
    },
  )

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the SDK's overloads infer arguments from its own zod typings; it validates them against the shape
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: {
      description: string
      inputSchema: z.ZodRawShape
      annotations: Record<string, boolean>
    },
    callback: (
      args: Record<string, unknown>,
    ) => Promise<
      ReturnType<typeof text> & { isError?: boolean; structuredContent?: ForbiddenError }
    >,
  ) => void

  for (const tool of toolsets.flatMap((toolset) => toolset.tools))
    register(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.input.shape,
        annotations: { readOnlyHint: tool.readOnly ?? true, openWorldHint: false },
      },
      async (args) => {
        const started = performance.now()
        let ok = true
        try {
          return text(
            await tool.run(args, { dir: process.cwd(), signal: new AbortController().signal }),
          )
        } catch (error) {
          ok = false
          const message = error instanceof Error ? error.message : String(error)
          const missing =
            error instanceof ForbiddenToolError || error instanceof ForbiddenException
              ? error.missing
              : undefined
          return {
            ...text(error instanceof ToolError || missing ? message : `Failed: ${message}`),
            ...(missing && { structuredContent: { error: message, missing } }),
            isError: true,
          }
        } finally {
          const subject = tool.subject?.(args)
          caller.usage.record({
            at: caller.now().toISOString(),
            tool: tool.name,
            principal: caller.principal.id,
            name: caller.principal.name,
            ...(caller.client ? { client: caller.client } : {}),
            ...(caller.token ? { token: caller.token } : {}),
            ...(subject ? { subject } : {}),
            ok,
            durationMs: Math.round(performance.now() - started),
          })
        }
      },
    )

  return server
}

/** Everything the MCP endpoint needs for one request. */
export type McpRequestContext = McpToolsetsContext & McpCaller

/**
 * Answers one request to the MCP endpoint (Streamable HTTP, stateless, JSON responses): a fresh
 * server per request with the registry's MCP toolsets, limited to the repositories the caller may
 * read. Every tool call is counted in `usage`.
 */
export async function handleMcpRequest(
  request: Request,
  context: McpRequestContext,
): Promise<Response> {
  const server = registryServer(mcpToolsets(context), context)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    void server.close()
  }
}
