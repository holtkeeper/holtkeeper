import { expect, test } from 'bun:test'

import { type McpTool, groupTools, mcpSetup, toolParams } from './mcp.ts'

test('mcpSetup', () => {
  const setup = mcpSetup('https://hk.test/mcp', 'hk_mcp_x')
  expect(setup.claudeCode).toBe(
    'claude mcp add --transport http holtkeeper https://hk.test/mcp --header "Authorization: Bearer hk_mcp_x"',
  )
  expect(JSON.parse(setup.json)).toEqual({
    mcpServers: {
      holtkeeper: {
        type: 'http',
        url: 'https://hk.test/mcp',
        headers: { Authorization: 'Bearer hk_mcp_x' },
      },
    },
  })
  expect(setup.curl).toContain('-H "Authorization: Bearer hk_mcp_x"')
  expect(mcpSetup('https://hk.test/mcp').claudeCode).toContain('Bearer <token>')
})

const tool = (name: string, inputSchema: McpTool['inputSchema'] = {}): McpTool => ({
  name,
  inputSchema,
})

test('toolParams lists required arguments first with readable types', () => {
  expect(
    toolParams(
      tool('search_library_docs', {
        properties: {
          ecosystem: { type: 'string', enum: ['npm', 'go'] },
          limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Default 10' },
          query: { type: 'string' },
          names: { type: 'array', items: { type: 'string' } },
        },
        required: ['query'],
      }),
    ),
  ).toEqual([
    { name: 'query', type: 'string', required: true },
    { name: 'ecosystem', type: '"npm" | "go"', required: false },
    { name: 'limit', type: 'integer 1–30', required: false, description: 'Default 10' },
    { name: 'names', type: 'string[]', required: false },
  ])
  expect(toolParams(tool('list_packages'))).toEqual([])
})

test('groupTools splits package and library tools and drops empty groups', () => {
  expect(
    groupTools([
      tool('list_packages'),
      tool('library_source'),
      tool('search_knowledge'),
      tool('evaluate_dependency'),
      tool('get_symbol'),
    ]).map((group) => [group.id, group.tools.map((t) => t.name)]),
  ).toEqual([
    ['packages', ['list_packages', 'get_symbol']],
    ['libraries', ['library_source', 'evaluate_dependency']],
    ['knowledge', ['search_knowledge']],
  ])
  expect(groupTools([tool('list_packages')]).map((group) => group.id)).toEqual(['packages'])
})
