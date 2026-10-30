import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import { mcpToolName, qualifiedToolName, sdkTool, toMcpServer } from './mcp.ts'
import type { AgentTool, Toolset } from './types.ts'

const ctx = { dir: '/repo', signal: new AbortController().signal }

const echo: AgentTool = {
  name: 'code.echo',
  description: 'Echo',
  input: z.object({ text: z.string() }),
  run: (input, { dir }) => `${dir}: ${String(input['text'])}`,
}

const failing: AgentTool = {
  name: 'code.fail',
  description: 'Fails',
  input: z.object({}),
  run: () => {
    throw new Error('boom')
  },
}

describe('mcp names', () => {
  test('dots become underscores', () => {
    expect(mcpToolName('code.search')).toBe('code_search')
    expect(qualifiedToolName('holtkeeper', 'docs.package')).toBe('mcp__holtkeeper__docs_package')
  })
})

describe('sdkTool', () => {
  test('runs the tool with the context and parsed input', async () => {
    const result = await sdkTool(echo, ctx).handler({ text: 'hi' }, undefined)
    expect(result.content).toEqual([{ type: 'text', text: '/repo: hi' }])
    expect(result.isError).toBeUndefined()
  })

  test('reports errors and invalid input as error results', async () => {
    const thrown = await sdkTool(failing, ctx).handler({}, undefined)
    expect(thrown.isError).toBe(true)
    expect(JSON.stringify(thrown.content)).toContain('error: boom')
    const invalid = await sdkTool(echo, ctx).handler({ text: 1 }, undefined)
    expect(invalid.isError).toBe(true)
  })
})

describe('toMcpServer', () => {
  test('serves every toolset and lists qualified names', () => {
    const toolsets: Toolset[] = [
      { name: 'a', tools: [echo] },
      { name: 'b', tools: [failing] },
    ]
    const mounted = toMcpServer(toolsets, ctx)
    expect(mounted.name).toBe('holtkeeper')
    expect(mounted.server.type).toBe('sdk')
    expect(mounted.allowedTools).toEqual([
      'mcp__holtkeeper__code_echo',
      'mcp__holtkeeper__code_fail',
    ])
  })

  test('rejects duplicate tool names', () => {
    expect(() => toMcpServer([{ name: 'a', tools: [echo, echo] }], ctx)).toThrow('duplicate')
  })
})
