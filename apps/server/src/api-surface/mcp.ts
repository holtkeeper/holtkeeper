import type { Principal } from '@holtkeeper/access'
import { type RegistryToolset, ToolError, capText } from '@holtkeeper/agent-tools'
import type { ForbiddenError } from '@holtkeeper/api'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'

import { ForbiddenException, ForbiddenToolError } from '../context.ts'
import { ASK_TOOL } from '../tools/ask.ts'
import { type McpToolsetsContext, mcpToolsets } from '../tools/registry.ts'
import type { McpUsage } from './usage.ts'

/** Longest text a tool returns over MCP; agents get a hint to narrow the request instead. */
const maxText = 80_000

const narrowHint =
  'narrow the request, e.g. package_api with `subpath`, `symbol`, `query` or `docs: false`'

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
  /**
   * Tools whose calls leave no trace: not counted in usage statistics, not even as a total, so
   * nothing ties them to the caller (anonymous secret reports).
   */
  unrecorded?: ReadonlySet<string>
  now: () => Date
}

/**
 * An MCP server serving `toolsets`: every tool under its own name and input schema, annotated
 * read-only unless it writes, with server instructions joined from the toolsets. A `ToolError`
 * reaches the client as it is, other failures as `Failed: <message>`; a missing permission
 * (`ForbiddenToolError`, `ForbiddenException`) also carries the `ForbiddenError` body as
 * `structuredContent`. Every call is recorded in `caller.usage` except calls of
 * `caller.unrecorded` tools. A tool gets the request's abort signal and, when the client sent a
 * progress token, a `progress` that reaches it as `notifications/progress` (on streamed
 * responses only).
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
      extra: {
        signal: AbortSignal
        _meta?: { progressToken?: string | number }
        sendNotification: (notification: {
          method: 'notifications/progress'
          params: { progressToken: string | number; progress: number; message: string }
        }) => Promise<void>
      },
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
      async (args, extra) => {
        const started = performance.now()
        // oxlint-disable-next-line no-underscore-dangle -- the field's name in the MCP protocol
        const progressToken = extra._meta?.progressToken
        let steps = 0
        const progress =
          progressToken === undefined
            ? undefined
            : (message: string) => {
                steps += 1
                void extra
                  .sendNotification({
                    method: 'notifications/progress',
                    params: { progressToken, progress: steps, message },
                  })
                  .catch(() => {})
              }
        let ok = true
        const record = () => {
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
        try {
          return text(
            await tool.run(args, {
              dir: process.cwd(),
              signal: extra.signal,
              ...(progress && { progress }),
            }),
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
          if (!caller.unrecorded?.has(tool.name)) record()
        }
      },
    )

  return server
}

/** Everything the MCP endpoint needs for one request. */
export type McpRequestContext = McpToolsetsContext & McpCaller

/** Tools slow enough that their calls are answered as an event stream carrying progress. */
const STREAMED_TOOLS: ReadonlySet<string> = new Set([ASK_TOOL])

/** How often a streamed response sends a keep-alive comment while its tool runs. */
const STREAM_KEEP_ALIVE_MS = 4000

/** Whether `request` is a single call of a streamed tool by a client that accepts event streams. */
async function wantsStream(request: Request): Promise<boolean> {
  if (!request.headers.get('accept')?.includes('text/event-stream')) return false
  const body: unknown = await request
    .clone()
    .json()
    .catch(() => undefined)
  const parsed = z
    .object({ method: z.literal('tools/call'), params: z.object({ name: z.string() }) })
    .safeParse(body)
  return parsed.success && STREAMED_TOOLS.has(parsed.data.params.name)
}

/**
 * Answers one request (Streamable HTTP, stateless) with a fresh server over `toolsets`.
 * Responses are JSON, except calls of `STREAMED_TOOLS`, which are answered as an event stream so
 * progress reaches the client while the tool runs, with a keep-alive comment every few seconds.
 * A request the client aborts closes the server, which aborts the signal of its running tools.
 */
export async function serveToolsets(
  request: Request,
  toolsets: readonly RegistryToolset[],
  caller: McpCaller,
): Promise<Response> {
  const server = registryServer(toolsets, caller)
  const stream = await wantsStream(request)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: !stream,
    // Keeps bytes flowing while a slow tool runs, under the idle timeouts of the HTTP server and
    // of proxies in front of it.
    ...(stream && { keepAliveMs: STREAM_KEEP_ALIVE_MS }),
  })
  await server.connect(transport)
  // A client that goes away (cancel, dropped connection) aborts the tool it was waiting for.
  if (request.signal.aborted) {
    void server.close()
    return new Response(null, { status: 499 })
  }
  request.signal.addEventListener('abort', () => void server.close(), { once: true })
  try {
    return await transport.handleRequest(request)
  } finally {
    // A streamed response is still being written; its transport ends with the stream.
    if (!stream) void server.close()
  }
}

/**
 * Answers one request to the MCP endpoint with the registry's MCP toolsets, limited to the
 * repositories the caller may read (`serveToolsets`). Every tool call is counted in `usage`.
 */
export const handleMcpRequest = (request: Request, context: McpRequestContext): Promise<Response> =>
  serveToolsets(request, mcpToolsets(context), context)
