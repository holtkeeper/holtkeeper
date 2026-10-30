import { describe, expect, test } from 'bun:test'

import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { type ClaudeQuery, createClaudeAgent } from '@holtkeeper/agent'

import {
  codeTools,
  context7Server,
  CONTEXT7_URL,
  docsTools,
  externalServers,
  toMcpServer,
} from '../src/index.ts'

const success = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'ok',
  num_turns: 1,
  total_cost_usd: 0,
} as unknown as SDKMessage

describe('MCP wiring', () => {
  test('toMcpServer lists every tool under its qualified name', () => {
    const mounted = toMcpServer([codeTools(), docsTools()], {
      dir: '/r',
      signal: new AbortController().signal,
    })
    expect(mounted.allowedTools).toEqual([
      'mcp__holtkeeper__code_search',
      'mcp__holtkeeper__code_grep',
      'mcp__holtkeeper__code_outline',
      'mcp__holtkeeper__code_symbol',
      'mcp__holtkeeper__code_references',
      'mcp__holtkeeper__code_read',
      'mcp__holtkeeper__code_dependents',
      'mcp__holtkeeper__code_dependencies',
      'mcp__holtkeeper__docs_package',
    ])
  })

  test('the Claude adapter mounts toolsets and Context7 and allows nothing else', async () => {
    const calls: Options[] = []
    const query: ClaudeQuery = async function* ({ options }) {
      calls.push(options ?? {})
      yield success
    }
    await createClaudeAgent({ apiKey: 'k' }, { query }).run({
      dir: '/repo',
      prompt: 'p',
      toolsets: [codeTools(), docsTools()],
      mcpServers: externalServers({ context7: true }),
    })
    const options = calls[0] ?? {}
    expect(options.allowedTools).toContain('mcp__holtkeeper__code_outline')
    expect(options.allowedTools).toContain('mcp__holtkeeper__docs_package')
    expect(options.allowedTools?.some((name) => !name.startsWith('mcp__holtkeeper__'))).toBe(false)
    expect(options.tools).toEqual(['Read', 'Glob', 'Grep'])
    expect(options.mcpServers?.['context7']).toEqual({
      type: 'http',
      url: CONTEXT7_URL,
      alwaysLoad: true,
    })
    expect(options.mcpServers?.['holtkeeper']?.type).toBe('sdk')
    const gate = options.canUseTool
    if (!gate) throw new Error('no gate')
    const verdict = async (tool: string) =>
      (
        await gate(
          tool,
          {},
          { signal: new AbortController().signal, toolUseID: 't', requestId: 'r' },
        )
      )?.behavior
    expect(await verdict('mcp__context7__resolve-library-id')).toBe('allow')
    expect(await verdict('WebFetch')).toBe('deny')
  })
})

describe('context7', () => {
  test('is off unless enabled', () => {
    expect(externalServers()).toEqual({})
    expect(externalServers({ context7: false })).toEqual({})
  })

  test('remote and stdio configs', () => {
    expect(context7Server({ apiKey: 'ck' })['context7']).toEqual({
      type: 'http',
      url: 'https://mcp.context7.com/mcp',
      headers: { Authorization: 'Bearer ck' },
      alwaysLoad: true,
    })
    expect(context7Server({ transport: 'stdio' })['context7']).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
      alwaysLoad: true,
    })
  })
})
