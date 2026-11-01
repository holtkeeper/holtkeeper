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
    curl: `curl -s ${endpoint} -H "${header}" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
  }
}

/** Expiry choices of a new token, in days; `0` never expires. */
export const tokenLifetimes = [
  { id: '30', label: '30 days' },
  { id: '90', label: '90 days' },
  { id: '365', label: '1 year' },
  { id: '0', label: 'Never' },
] as const

/** The MCP tools agents use to read indexed library docs. */
export const libraryTools = [
  'library_versions',
  'search_library_docs',
  'read_library_doc',
  'library_changes',
  'search_library_issues',
  'library_source',
] as const

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

const knowledgeTools = new Set(['search_knowledge', 'get_knowledge', 'propose_knowledge'])

const isLibraryTool = (name: string) =>
  name === 'evaluate_dependency' || (libraryTools as readonly string[]).includes(name)
const isKnowledgeTool = (name: string) => knowledgeTools.has(name)

/**
 * `tools` split into the catalog of the organization's packages, third-party libraries and the
 * knowledge base; empty groups are left out.
 */
export const groupTools = (tools: readonly McpTool[]) =>
  [
    {
      id: 'packages',
      label: 'Your packages',
      description:
        'Exports, versions, usages and upgrade impact of the packages your repositories publish.',
      tools: tools.filter((tool) => !isLibraryTool(tool.name) && !isKnowledgeTool(tool.name)),
    },
    {
      id: 'libraries',
      label: 'Third-party libraries',
      description:
        'Whether to add or upgrade a dependency, and the docs, changes, issues and source of the libraries your repositories depend on, at the version each repository uses.',
      tools: tools.filter((tool) => isLibraryTool(tool.name)),
    },
    {
      id: 'knowledge',
      label: 'Team knowledge',
      description:
        'Decisions, conventions and migration notes of the knowledge base; proposals from agents wait for review on the Knowledge page.',
      tools: tools.filter((tool) => isKnowledgeTool(tool.name)),
    },
  ].filter((group) => group.tools.length)
