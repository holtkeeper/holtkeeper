import { describe, expect, test } from 'bun:test'

import { probeAgentLoop } from './probe.ts'

interface Seen {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

function fakeFetch(status: number, body: unknown) {
  const seen: Seen[] = []
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: url instanceof Request ? url.url : url.toString(),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}'),
    })
    return new Response(JSON.stringify(body), { status })
  }) as typeof globalThis.fetch
  return { fetch, seen }
}

const gateway = {
  kind: 'anthropic-compatible',
  url: 'https://llm.corp.test/anthropic/v1',
  secret: 'gateway-secret-123',
  options: { authHeader: 'bearer', modelMap: { 'claude-sonnet-5-5': 'corp-sonnet' } },
}

describe('probeAgentLoop', () => {
  test('ok when the answer calls the tool; sends tools, cache_control and auto tool choice', async () => {
    const { fetch, seen } = fakeFetch(200, {
      content: [{ type: 'tool_use', id: 't', name: 'record_word', input: { word: 'ok' } }],
      stop_reason: 'tool_use',
    })
    const probe = await probeAgentLoop(gateway, 'claude-sonnet-5-5', { fetch })
    expect(probe).toMatchObject({ status: 'ok', model: 'corp-sonnet' })
    const request = seen[0]
    expect(request?.url).toBe('https://llm.corp.test/anthropic/v1/messages')
    expect(request?.headers['authorization']).toBe('Bearer gateway-secret-123')
    expect(request?.body).toMatchObject({
      model: 'corp-sonnet',
      tool_choice: { type: 'auto' },
      system: [{ cache_control: { type: 'ephemeral' } }],
    })
    expect(request?.body['tools']).toHaveLength(1)
  })

  test('failed on HTTP errors, without the secret, and when no tool is called', async () => {
    const refused = fakeFetch(400, {
      error: { type: 'invalid_request_error', message: 'tools unsupported for gateway-secret-123' },
    })
    expect(await probeAgentLoop(gateway, 'claude-sonnet-5-5', refused)).toMatchObject({
      status: 'failed',
      error: 'HTTP 400: tools unsupported for [redacted]',
      conclusive: true,
    })
    const limited = fakeFetch(429, { error: { message: 'slow down' } })
    expect(await probeAgentLoop(gateway, 'm', limited)).toMatchObject({
      status: 'failed',
      conclusive: false,
    })
    const chatty = fakeFetch(200, { content: [{ type: 'text', text: 'ok' }] })
    expect(await probeAgentLoop(gateway, 'claude-sonnet-5-5', chatty)).toMatchObject({
      status: 'failed',
      error: 'the model answered without calling the tool',
    })
    const broken = fakeFetch(200, { choices: [] })
    expect((await probeAgentLoop(gateway, 'm', broken)).error).toBe(
      'the answer is not a Messages response',
    )
    const down = (async () => {
      throw new Error('connection refused')
    }) as unknown as typeof globalThis.fetch
    expect(await probeAgentLoop(gateway, 'm', { fetch: down })).toMatchObject({
      error: 'connection refused',
      conclusive: false,
    })
  })

  test('x-api-key for Anthropic and a refusal for ai-sdk providers', async () => {
    const { fetch, seen } = fakeFetch(200, { content: [] })
    await probeAgentLoop(
      { kind: 'anthropic', url: 'https://api.anthropic.com', secret: 'k' },
      'm',
      {
        fetch,
      },
    )
    expect(seen[0]?.url).toBe('https://api.anthropic.com/v1/messages')
    expect(seen[0]?.headers['x-api-key']).toBe('k')
    expect(
      probeAgentLoop(
        { kind: 'ai-sdk', url: 'https://x.test', secret: 's', options: { provider: 'p' } },
        'm',
      ),
    ).rejects.toThrow('only Anthropic Messages providers')
  })
})
