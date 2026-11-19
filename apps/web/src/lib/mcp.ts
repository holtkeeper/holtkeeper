/** Ways to add the MCP endpoint to clients; `secret` defaults to a placeholder. */
export function mcpSetup(endpoint: string, secret = '<token>') {
  const header = `Authorization: Bearer ${secret}`
  return {
    claudeCode: `claude mcp add --transport http holtkeeper ${endpoint} --header "${header}"`,
    json: JSON.stringify(
      {
        mcpServers: {
          holtkeeper: {
            type: 'http',
            url: endpoint,
            headers: { Authorization: `Bearer ${secret}` },
          },
        },
      },
      null,
      2,
    ),
    cursor: JSON.stringify(
      {
        mcpServers: {
          holtkeeper: { url: endpoint, headers: { Authorization: `Bearer ${secret}` } },
        },
      },
      null,
      2,
    ),
    curl: `curl -s ${endpoint} -H "${header}" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
  }
}

/** A client the setup block has a tab for. */
export type McpClient = 'claude-code' | 'cursor' | 'json' | 'curl'

/** The setup block's client tabs in order, each naming the `mcpSetup` field it shows. */
export const mcpClients: readonly {
  id: McpClient
  label: string
  field: keyof ReturnType<typeof mcpSetup>
}[] = [
  { id: 'claude-code', label: 'Claude Code', field: 'claudeCode' },
  { id: 'cursor', label: 'Cursor', field: 'cursor' },
  { id: 'json', label: '.mcp.json', field: 'json' },
  { id: 'curl', label: 'curl check', field: 'curl' },
]

/** Expiry choices of a new token, in days; `0` never expires. */
export const tokenLifetimes = [
  { id: '30', label: '30 days' },
  { id: '90', label: '90 days' },
  { id: '365', label: '1 year' },
  { id: '0', label: 'Never' },
] as const

/** The MCP tools agents use to read indexed library docs, changes and source. */
export const libraryTools = ['package_docs', 'package_changes', 'package_source'] as const

interface JsonSchema {
  type?: string | string[]
  description?: string
  enum?: unknown[]
  items?: JsonSchema
  anyOf?: JsonSchema[]
  minimum?: number
  maximum?: number
}

/** A tool as the MCP endpoint lists it (`tools/list`). */
export interface McpTool {
  name: string
  description?: string
  inputSchema: { properties?: Record<string, JsonSchema>; required?: string[] }
}

/** One argument of a tool, ready to show. */
export interface McpToolParam {
  name: string
  type: string
  required: boolean
  description?: string
}

const typeOf = (schema: JsonSchema): string => {
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(' | ')
  if (schema.anyOf) return schema.anyOf.map(typeOf).join(' | ')
  const base = Array.isArray(schema.type) ? schema.type.join(' | ') : (schema.type ?? 'any')
  if (base === 'array') return `${schema.items ? typeOf(schema.items) : 'any'}[]`
  if (schema.minimum !== undefined && schema.maximum !== undefined)
    return `${base} ${schema.minimum}–${schema.maximum}`
  return base
}

/** The arguments of `tool`, required ones first, otherwise in schema order. */
export const toolParams = (tool: McpTool): McpToolParam[] => {
  const required = new Set(tool.inputSchema.required ?? [])
  return Object.entries(tool.inputSchema.properties ?? {})
    .map(([name, schema]) => {
      const param: McpToolParam = { name, type: typeOf(schema), required: required.has(name) }
      if (schema.description) param.description = schema.description
      return param
    })
    .toSorted((a, b) => Number(b.required) - Number(a.required))
}

const packageTools = new Set([
  'find_packages',
  'package_api',
  'package_changes',
  'package_usage',
  'package_docs',
  'package_source',
  'evaluate_dependency',
])
const knowledgeTools = new Set(['search_knowledge', 'propose_learning'])

type ToolGroup = 'packages' | 'repository' | 'knowledge' | 'ask' | 'qa'

const groupOf = (name: string): ToolGroup => {
  if (packageTools.has(name)) return 'packages'
  if (knowledgeTools.has(name)) return 'knowledge'
  if (name === 'ask') return 'ask'
  if (name.startsWith('qa_')) return 'qa'
  return 'repository'
}

/**
 * `tools` split into packages (the organization's own and third-party ones), what applies to one
 * repository, the knowledge base, `ask` and QA tasks; empty groups are left out.
 */
export const groupTools = (tools: readonly McpTool[]) =>
  (
    [
      {
        id: 'packages',
        label: 'Packages',
        description:
          'API, docs, source, versions, changes and usages of your own packages and the third-party libraries your repositories depend on, at the version each repository uses.',
      },
      {
        id: 'repository',
        label: 'Repository',
        description:
          'Rules and conventions agents follow in a repository, its test ids and assets, and code reviews of its merge requests.',
      },
      {
        id: 'knowledge',
        label: 'Team knowledge',
        description:
          'Search team rules and the learnings Holtkeeper picked up, read one in full; proposed learnings wait in Knowledge › Learnings.',
      },
      {
        id: 'ask',
        label: 'Ask',
        description:
          'One question answered by an agent over the other tools, every statement with its source. Offered while the mcp.ask setting is on; spends the AI budget.',
      },
      {
        id: 'qa',
        label: 'QA tasks',
        description:
          'Changes, test ids and stored test notes of the tasks in Releases › QA. Off for new tokens; turn it on in a token’s tools.',
      },
    ] as const
  )
    .map((group) =>
      Object.assign({ tools: tools.filter((tool) => groupOf(tool.name) === group.id) }, group),
    )
    .filter((group) => group.tools.length)
