import { describe, expect, test } from 'bun:test'

import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { MockLanguageModelV4 } from 'ai/test'

import type { ClaudeQuery } from './claude.ts'
import { createAgent, limitConcurrency, pingAiSdkProvider } from './factory.ts'
import type { Agent, AgentResult } from './types.ts'

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
  test('anthropic-compatible: endpoint from the credential, headers rendered, models routed and mapped', async () => {
    const { query, calls } = recordingQuery()
    const agent = createAgent(
      {
        kind: 'anthropic-compatible',
        url: 'https://llm.corp.test/anthropic',
        secret: 'tok',
        options: {
          authHeader: 'bearer',
          headers: { 'X-Api-Key': '{secret}' },
          models: { triage: 'claude-haiku-5-5' },
          modelMap: { 'claude-haiku-5-5': 'corp-haiku', 'claude-opus-5-5': 'corp-opus' },
        },
      },
      { query, models: { review: 'claude-opus-5-5' } },
    )
    expect(agent.provider).toBe('anthropic-compatible')
    expect(agent.modelFor('triage')).toBe('corp-haiku')
    expect(agent.modelFor('review')).toBe('corp-opus')
    await agent.run({ dir: '/r', prompt: 'p', taskKind: 'triage' })
    const env = calls[0]?.env ?? {}
    expect(calls[0]?.model).toBe('corp-haiku')
    expect(env['ANTHROPIC_BASE_URL']).toBe('https://llm.corp.test/anthropic')
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBe('tok')
    expect(env['ANTHROPIC_CUSTOM_HEADERS']).toBe('X-Api-Key: tok')
  })

  test('openai-compatible runs on the tool loop with bearer auth unless headers carry it', async () => {
    const seen: { url: string; headers: Record<string, string>; model: string }[] = []
    const fetch = async (url: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as { model: string }
      seen.push({ url, headers: init.headers as Record<string, string>, model: body.model })
      return Response.json({ choices: [{ message: { content: 'done' } }] })
    }
    const plain = createAgent(
      {
        kind: 'openai-compatible',
        url: 'https://gw.test/v1',
        secret: 'sk',
        options: { model: 'gpt-x' },
      },
      { fetch },
    )
    expect(plain.name).toBe('openai-compatible')
    expect((await plain.run({ dir: '/r', prompt: 'p' })).text).toBe('done')
    const custom = createAgent(
      {
        kind: 'openai-compatible',
        url: 'https://gw.test/v1',
        secret: 'sk',
        options: {
          baseUrl: 'https://other.test/api',
          headers: { Authorization: 'Token {secret}' },
        },
      },
      { fetch },
    )
    await custom.run({ dir: '/r', prompt: 'p' })
    expect(seen[0]).toMatchObject({ url: 'https://gw.test/v1/chat/completions', model: 'gpt-x' })
    expect(seen[0]?.headers['authorization']).toBe('Bearer sk')
    expect(seen[1]?.url).toBe('https://other.test/api/chat/completions')
    expect(seen[1]?.headers['Authorization']).toBe('Token sk')
    expect(seen[1]?.headers['authorization']).toBeUndefined()
  })

  test('rejects invalid options and kinds', () => {
    expect(() =>
      createAgent({ kind: 'vertex', url: 'https://x.test', secret: '-', options: { region: 'r' } }),
    ).toThrow('options.projectId')
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
  test('routes models, merges catalog prices under the provider pricing and reports the model', async () => {
    const ids: string[] = []
    const agent = createAgent(
      {
        kind: 'ai-sdk',
        url: 'https://openrouter.ai/api/v1',
        secret: 'sk-or',
        options: {
          provider: 'openrouter',
          package: '@openrouter/ai-sdk-provider',
          model: 'openai/gpt-5',
          models: { triage: 'openai/gpt-5-mini' },
          pricing: { 'openai/gpt-5': { inputPerMTok: 2, outputPerMTok: 8 } },
        },
      },
      {
        pricing: {
          'openai/gpt-5': { inputPerMTok: 99, outputPerMTok: 99 },
          'openai/gpt-5-mini': { inputPerMTok: 0.5, outputPerMTok: 1 },
        },
        languageModel: (id) => {
          ids.push(id)
          return reply('ok')
        },
      },
    )
    expect(agent.provider).toBe('ai-sdk')
    expect(agent.modelFor('triage')).toBe('openai/gpt-5-mini')
    expect(agent.modelFor('review')).toBe('openai/gpt-5')
    expect((await agent.run({ dir: '/tmp', prompt: 'p', capabilities: [] })).costUsd).toBe(2)
    expect(
      (await agent.run({ dir: '/tmp', prompt: 'p', capabilities: [], taskKind: 'triage' })).costUsd,
    ).toBe(0.5)
    expect(ids).toEqual(['openai/gpt-5', 'openai/gpt-5-mini'])
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
      await failure(
        pingAiSdkProvider({ ...provider, kind: 'openai-compatible', options: {} }, 'm'),
      ),
    ).toContain('cannot be pinged')
  })
})
