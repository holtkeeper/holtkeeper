import { describe, expect, test } from 'bun:test'

import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'

import type { ClaudeQuery } from './claude.ts'
import { createAgent, limitConcurrency } from './factory.ts'
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
