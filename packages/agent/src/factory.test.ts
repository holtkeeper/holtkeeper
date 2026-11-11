import { describe, expect, test } from 'bun:test'

import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'

import type { ClaudeQuery } from './claude.ts'
import {
  anthropicMessagesConnection,
  createAgent,
  limitConcurrency,
  needsToolLoop,
  pingAiSdkProvider,
  runtimeFor,
} from './factory.ts'
import { parseProviderOptions } from './provider.ts'
import { createTranscript } from './transcript.ts'
import type { Agent, AgentResult, Toolset } from './types.ts'

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return 'resolved'
}

const success = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'ok',
  num_turns: 1,
  total_cost_usd: 0,
} as unknown as SDKMessage

function recordingQuery() {
  const calls: Options[] = []
  const query: ClaudeQuery = async function* ({ options }) {
    calls.push(options ?? {})
    yield success
  }
  return { query, calls }
}

describe('createAgent', () => {
  test('anthropic-compatible: endpoint from the credential, headers rendered, tier models mapped', async () => {
    const { query, calls } = recordingQuery()
    const agent = createAgent(
      {
        kind: 'anthropic-compatible',
        url: 'https://llm.corp.test/anthropic',
        secret: 'tok',
        options: {
          authHeader: 'bearer',
          headers: { 'X-Api-Key': '{secret}' },
          modelMap: { 'claude-haiku-5-5': 'corp-haiku', 'claude-opus-5-5': 'corp-opus' },
        },
      },
      { query },
    )
    expect(agent.provider).toBe('anthropic-compatible')
    expect(agent.modelFor('fast')).toBe('corp-haiku')
    expect(agent.modelFor('deep')).toBe('corp-opus')
    expect(agent.modelFor()).toBe('claude-sonnet-5-5')
    await agent.run({ dir: '/r', prompt: 'p', tier: 'fast' })
    const env = calls[0]?.env ?? {}
    expect(calls[0]?.model).toBe('corp-haiku')
    expect(env['ANTHROPIC_DEFAULT_HAIKU_MODEL']).toBe('corp-haiku')
    expect(env['ANTHROPIC_BASE_URL']).toBe('https://llm.corp.test/anthropic')
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBe('tok')
    expect(env['ANTHROPIC_CUSTOM_HEADERS']).toBe('X-Api-Key: tok')
  })

  test('rejects invalid options and kinds', () => {
    expect(() =>
      createAgent({
        kind: 'anthropic-compatible',
        url: 'https://x.test',
        secret: '-',
        options: { authHeader: 'basic' },
      }),
    ).toThrow('options.authHeader')
    expect(() => createAgent({ kind: 'vertex', url: 'https://x.test', secret: '-' })).toThrow(
      'not an AI provider kind',
    )
    expect(() => createAgent({ kind: 'gitlab', url: 'https://x.test', secret: '-' })).toThrow(
      'not an AI provider kind',
    )
  })

  test('maxConcurrency limits parallel runs', async () => {
    let active = 0
    let peak = 0
    const query: ClaudeQuery = async function* () {
      active++
      peak = Math.max(peak, active)
      await Bun.sleep(5)
      active--
      yield success
    }
    const agent = createAgent(
      {
        kind: 'anthropic',
        url: 'https://api.anthropic.com',
        secret: 'k',
        options: { maxConcurrency: 2 },
      },
      { query },
    )
    await Promise.all(Array.from({ length: 5 }, () => agent.run({ dir: '/r', prompt: 'p' })))
    expect(peak).toBe(2)
    expect(agent.provider).toBe('anthropic')
  })
})

describe('limitConcurrency', () => {
  test('a task aborted while waiting is rejected and frees nothing', async () => {
    let release: (() => void) | undefined
    const inner: Agent = {
      name: 'slow',
      run: () =>
        new Promise<AgentResult<never>>((resolve) => {
          release = () => resolve({ text: 'ok', turns: 1 })
        }),
    }
    const agent = limitConcurrency(inner, 1)
    const first = agent.run({ dir: '/r', prompt: 'a' })
    const controller = new AbortController()
    const second = agent.run({ dir: '/r', prompt: 'b', signal: controller.signal })
    controller.abort(new Error('stop'))
    expect(await failure(second)).toContain('stop')
    release?.()
    expect((await first).text).toBe('ok')
  })
})

const reply = (text: string) =>
  new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 1_000_000, noCache: 1_000_000, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 0, text: 0, reasoning: 0 },
      },
      warnings: [],
    },
  })

describe('ai-sdk providers', () => {
  test('runs tier models, merges catalog prices under the provider pricing and reports the model', async () => {
    const ids: string[] = []
    const agent = createAgent(
      {
        kind: 'ai-sdk',
        url: 'https://openrouter.ai/api/v1',
        secret: 'sk-or',
        options: {
          provider: 'openrouter',
          package: '@openrouter/ai-sdk-provider',
          pricing: { 'vendor/claude-sonnet-5.5': { inputPerMTok: 2, outputPerMTok: 8 } },
        },
      },
      {
        tierModels: {
          fast: 'vendor/claude-haiku-5.5',
          main: 'vendor/claude-sonnet-5.5',
          deep: 'vendor/claude-opus-5.5',
        },
        pricing: {
          'vendor/claude-sonnet-5.5': { inputPerMTok: 99, outputPerMTok: 99 },
          'vendor/claude-haiku-5.5': { inputPerMTok: 0.5, outputPerMTok: 1 },
        },
        languageModel: (id) => {
          ids.push(id)
          return reply('ok')
        },
      },
    )
    expect(agent.provider).toBe('ai-sdk')
    expect(agent.modelFor('fast')).toBe('vendor/claude-haiku-5.5')
    expect(agent.modelFor('deep')).toBe('vendor/claude-opus-5.5')
    expect((await agent.run({ dir: '/tmp', prompt: 'p', capabilities: [] })).costUsd).toBe(2)
    expect(
      (await agent.run({ dir: '/tmp', prompt: 'p', capabilities: [], tier: 'fast' })).costUsd,
    ).toBe(0.5)
    expect(ids).toEqual(['vendor/claude-sonnet-5.5', 'vendor/claude-haiku-5.5'])
  })

  test('options are validated: shipped packages only, OpenAI-compatible by default', () => {
    expect(() =>
      createAgent({
        kind: 'ai-sdk',
        url: 'https://x.test',
        secret: 's',
        options: { provider: 'x', package: 'left-pad' },
      }),
    ).toThrow('options.package')
    expect(() =>
      createAgent({ kind: 'ai-sdk', url: 'https://x.test', secret: 's', options: {} }),
    ).toThrow('options.provider')
    expect(
      createAgent({
        kind: 'ai-sdk',
        url: 'https://x.test',
        secret: 's',
        options: { provider: 'mine' },
      }).provider,
    ).toBe('ai-sdk')
  })

  test('ping asks the model for a short reply', async () => {
    const provider = {
      kind: 'ai-sdk',
      url: 'https://x.test',
      secret: 's',
      options: { provider: 'mine' },
    }
    const result = await pingAiSdkProvider(provider, 'm', { languageModel: () => reply(' OK ') })
    expect(result.text).toBe('OK')
    expect(
      await failure(pingAiSdkProvider({ ...provider, kind: 'anthropic', options: {} }, 'm')),
    ).toContain('cannot be pinged')
  })
})

const toolset: Toolset = {
  name: 'notes',
  tools: [
    { name: 'notes.read', description: 'Reads a note.', input: z.object({}), run: () => 'n' },
  ],
}

const messagesConnection = (provider: {
  kind: string
  url: string
  secret: string
  options?: object
}) => {
  const parsed = parseProviderOptions({ ...provider, options: { ...provider.options } })
  if (parsed.kind === 'ai-sdk') throw new Error('unexpected')
  return anthropicMessagesConnection(
    { ...provider, options: { ...provider.options } },
    parsed,
    parsed.baseUrl ?? provider.url,
  )
}

describe('runtime routing', () => {
  test('a tool loop is any capability, toolset or MCP server; one-shots have none', () => {
    expect(needsToolLoop({})).toBeTrue()
    expect(needsToolLoop({ capabilities: [] })).toBeFalse()
    expect(needsToolLoop({ capabilities: [], toolsets: [{ name: 'x', tools: [] }] })).toBeFalse()
    expect(needsToolLoop({ capabilities: [], toolsets: [toolset] })).toBeTrue()
    expect(
      needsToolLoop({ capabilities: [], mcpServers: { other: { type: 'http', url: 'http://x' } } }),
    ).toBeTrue()
  })

  test('Anthropic kinds run tool loops on the SDK unless the probe failed; ai-sdk never', () => {
    const loop = { capabilities: ['read' as const] }
    const oneShot = { capabilities: [] }
    expect(runtimeFor('anthropic', loop)).toBe('claude-sdk')
    expect(runtimeFor('anthropic-compatible', loop, 'ok')).toBe('claude-sdk')
    expect(runtimeFor('anthropic-compatible', loop, 'unknown')).toBe('claude-sdk')
    expect(runtimeFor('anthropic-compatible', loop, 'failed')).toBe('ai-sdk')
    expect(runtimeFor('anthropic', oneShot, 'ok')).toBe('ai-sdk')
    expect(runtimeFor('ai-sdk', loop, 'ok')).toBe('ai-sdk')
  })

  const gateway = {
    kind: 'anthropic-compatible',
    url: 'https://llm.corp.test/anthropic',
    secret: 'gateway-secret-123',
    options: { authHeader: 'bearer' },
  }

  test('createAgent sends tool loops to the SDK and one-shots to the AI SDK', async () => {
    const { query, calls } = recordingQuery()
    const models: string[] = []
    const agent = createAgent(gateway, {
      query,
      languageModel: (id) => {
        models.push(id)
        return reply('one-shot')
      },
    })
    const loop = await agent.run({ dir: '/r', prompt: 'p', toolsets: [toolset], capabilities: [] })
    expect(loop.runtime).toBe('claude-sdk')
    const oneShot = await agent.run({ dir: '/r', prompt: 'p', capabilities: [], tier: 'fast' })
    expect(oneShot).toMatchObject({ runtime: 'ai-sdk', text: 'one-shot' })
    expect(calls.length).toBe(1)
    expect(models).toEqual(['claude-haiku-5-5'])
    expect(agent.runtimeFor({ dir: '/r', prompt: 'p' })).toBe('claude-sdk')
  })

  test('a failed probe moves tool loops to the AI SDK loop', async () => {
    const { query, calls } = recordingQuery()
    const agent = createAgent(gateway, {
      query,
      agentLoop: 'failed',
      languageModel: () => reply('fallback'),
    })
    const result = await agent.run({
      dir: '/r',
      prompt: 'p',
      capabilities: [],
      toolsets: [toolset],
    })
    expect(result).toMatchObject({ runtime: 'ai-sdk', text: 'fallback' })
    expect(calls).toEqual([])
    expect(agent.runtimeFor({ dir: '/r', prompt: 'p' })).toBe('ai-sdk')
  })

  test('transcripts never receive the provider secret or rendered headers', async () => {
    const leaky = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: 'text', text: 'the key is gateway-secret-123 and team-header-value' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      },
    })
    const agent = createAgent(
      { ...gateway, options: { headers: { 'X-Team': 'team-header-value' } } },
      { languageModel: () => leaky },
    )
    const transcript = createTranscript()
    await agent.run({ dir: '/r', prompt: 'p', capabilities: [], transcript })
    const jsonl = transcript.toJsonl()
    expect(jsonl).not.toContain('gateway-secret-123')
    expect(jsonl).not.toContain('team-header-value')
    expect(transcript.lines().map((line) => line.type)).toEqual(['start', 'assistant', 'end'])
  })

  test('the AI SDK reaches the same Messages endpoint and auth as Claude Code', () => {
    expect(
      messagesConnection({
        ...gateway,
        url: 'https://llm.corp.test/anthropic/',
        options: { authHeader: 'bearer', headers: { 'X-Key': '{secret}' } },
      }),
    ).toEqual({
      package: '@ai-sdk/anthropic',
      name: 'anthropic-compatible',
      secret: '',
      baseUrl: 'https://llm.corp.test/anthropic/v1',
      headers: { 'X-Key': 'gateway-secret-123' },
      settings: { authToken: 'gateway-secret-123' },
    })
    expect(
      messagesConnection({ kind: 'anthropic', url: 'https://api.anthropic.com/v1', secret: 'k' }),
    ).toEqual({
      package: '@ai-sdk/anthropic',
      name: 'anthropic',
      secret: 'k',
      baseUrl: 'https://api.anthropic.com/v1',
    })
  })
})
