import { describe, expect, test } from 'bun:test'

import type { Principal } from '@holtkeeper/access'
import { ToolError, defineTool } from '@holtkeeper/agent-tools'
import { z } from 'zod'

import { type AskAccess, askToolset } from '../tools/ask.ts'
import { type McpCaller, serveToolsets } from './mcp.ts'

const principal: Principal = { id: 'u1', name: 'Uma', provider: 'test', grants: [] }

function setup(access: AskAccess) {
  const recorded: { tool: string; ok: boolean }[] = []
  const caller: McpCaller = {
    principal,
    usage: { record: (call) => void recorded.push({ tool: call.tool, ok: call.ok }) },
    now: () => new Date('2026-01-07T10:00:00Z'),
  }
  const toolsets = [
    askToolset(access),
    {
      name: 'echo',
      tools: [
        defineTool({
          name: 'echo',
          description: 'Repeats its input.',
          input: z.object({ text: z.string() }),
          run: async ({ text }) => text,
        }),
      ],
    },
  ]
  const call = (name: string, args: Record<string, unknown>, accept: string) =>
    serveToolsets(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name, arguments: args, _meta: { progressToken: 'p1' } },
        }),
      }),
      toolsets,
      caller,
    )
  return { call, recorded }
}

const events = (body: string) =>
  body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>)

const both = 'application/json, text/event-stream'

describe('serveToolsets', () => {
  test('streams ask calls with progress before the answer', async () => {
    const { call, recorded } = setup({
      ask: async ({ question }, ctx) => {
        ctx.progress?.('read package_api')
        return `Answer to: ${question}`
      },
    })
    const response = await call('ask', { question: 'Where do widget sizes live?' }, both)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const messages = events(await response.text())
    expect(messages[0]).toMatchObject({
      method: 'notifications/progress',
      params: { progressToken: 'p1', progress: 1, message: 'read package_api' },
    })
    expect(messages.at(-1)).toMatchObject({
      id: 7,
      result: { content: [{ type: 'text', text: 'Answer to: Where do widget sizes live?' }] },
    })
    expect(recorded).toEqual([{ tool: 'ask', ok: true }])
  })

  test('answers other tools, and clients without event streams, as JSON', async () => {
    const { call } = setup({ ask: async () => 'An answer [rule:r1].' })
    const echo = await call('echo', { text: 'hello' }, both)
    expect(echo.headers.get('content-type')).toContain('application/json')
    expect(await echo.json()).toMatchObject({ result: { content: [{ text: 'hello' }] } })
  })

  test('passes a refusal to the caller as it is', async () => {
    const { call, recorded } = setup({
      ask: async () => {
        throw new ToolError('You asked 30 questions today, the daily limit.')
      },
    })
    const response = await call('ask', { question: 'One more question?' }, both)
    expect(events(await response.text()).at(-1)).toMatchObject({
      result: {
        isError: true,
        content: [{ text: 'You asked 30 questions today, the daily limit.' }],
      },
    })
    expect(recorded).toEqual([{ tool: 'ask', ok: false }])
  })
})
