import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

import { claudeEnv, type ClaudeQuery, createClaudeAgent, modelFor, toolsFor } from './claude.ts'
import { BudgetExceededError } from './errors.ts'
import { createTranscript } from './transcript.ts'
import type { AgentTool } from './types.ts'

function success(result: string, extra: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result,
    num_turns: 3,
    total_cost_usd: 0.25,
    ...extra,
  } as unknown as SDKMessage
}

function fakeQuery(messages: SDKMessage[]) {
  const calls: { prompt: string; options: Options }[] = []
  const query: ClaudeQuery = async function* ({ prompt, options }) {
    calls.push({ prompt, options: options ?? {} })
    yield* messages
  }
  return { query, calls }
}

const signal = new AbortController().signal

describe('toolsFor', () => {
  test('maps capabilities to tools', () => {
    expect(toolsFor(['read', 'search'])).toEqual(['Read', 'Glob', 'Grep'])
    expect(toolsFor(['read', 'run', 'edit', 'read'])).toEqual([
      'Read',
      'Glob',
      'Bash',
      'Edit',
      'Write',
    ])
  })
})

describe('createClaudeAgent', () => {
  test('passes dir, tools, model, key and limits to the SDK', async () => {
    const { query, calls } = fakeQuery([success('done')])
    const agent = createClaudeAgent({ apiKey: 'sk-test', maxTurns: 7 }, { query })
    const result = await agent.run({ dir: '/repo', prompt: 'review', system: 'Be brief.' })

    expect(agent.name).toBe('claude')
    expect(result).toEqual({
      text: 'done',
      turns: 3,
      costUsd: 0.25,
      model: 'claude-sonnet-5-5',
      runtime: 'claude-sdk',
    })
    const [call] = calls
    expect(call?.prompt).toBe('review')
    const options = call?.options ?? {}
    expect(options.cwd).toBe('/repo')
    expect(options.model).toBe('claude-sonnet-5-5')
    expect(options.tools).toEqual(['Read', 'Glob', 'Grep'])
    expect(options.allowedTools).toEqual([])
    expect(options.maxTurns).toBe(7)
    expect(options.settingSources).toEqual([])
    expect(options.sandbox).toBeUndefined()
    expect(options.env?.['ANTHROPIC_API_KEY']).toBe('sk-test')
    expect(options.env?.['GITLAB_TOKEN']).toBeUndefined()
    const system = options.systemPrompt
    expect(
      typeof system === 'object' && !Array.isArray(system) && system.type === 'preset'
        ? system.append
        : '',
    ).toContain('Be brief.')
  })

  test('task settings override defaults and run enables the sandbox', async () => {
    const { query, calls } = fakeQuery([success('ok')])
    const agent = createClaudeAgent(
      {
        apiKey: 'k',
        tierModels: { fast: 'claude-f', main: 'claude-x', deep: 'claude-d' },
        pathToClaudeCodeExecutable: '/bin/claude',
      },
      { query },
    )
    await agent.run({ dir: '/repo', prompt: 'p', capabilities: ['read', 'run'], maxTurns: 2 })
    const options = calls[0]?.options ?? {}
    expect(options.model).toBe('claude-x')
    expect(options.maxTurns).toBe(2)
    expect(options.tools).toEqual(['Read', 'Glob', 'Bash'])
    expect(options.pathToClaudeCodeExecutable).toBe('/bin/claude')
    expect(options.sandbox?.enabled).toBe(true)
  })

  test('permission gate denies other tools and paths outside dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hk-agent-'))
    try {
      const { query, calls } = fakeQuery([success('ok')])
      await createClaudeAgent({ apiKey: 'k' }, { query }).run({
        dir,
        prompt: 'p',
        capabilities: ['read', 'edit'],
      })
      const gate = calls[0]?.options.canUseTool
      if (!gate) throw new Error('no gate')
      const ask = async (tool: string, input: Record<string, unknown>) =>
        (await gate(tool, input, { signal, toolUseID: 't', requestId: 'r' }))?.behavior

      expect(await ask('Bash', { command: 'ls' })).toBe('deny')
      expect(await ask('WebFetch', { url: 'https://example.com' })).toBe('deny')
      expect(await ask('Read', { file_path: '/etc/passwd' })).toBe('deny')
      expect(await ask('Read', { file_path: join(dir, '..', 'x') })).toBe('deny')
      expect(await ask('Glob', { pattern: '/etc/*' })).toBe('deny')
      expect(await ask('Edit', { file_path: join(dir, 'src', 'a.ts') })).toBe('allow')
      expect(await ask('Write', { file_path: 'src/b.ts' })).toBe('allow')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('parses and validates structured output', async () => {
    const schema = z.object({ path: z.string(), notes: z.string() })
    const { query, calls } = fakeQuery([success('```json\n{"path":"a.test.ts","notes":"n"}\n```')])
    const result = await createClaudeAgent({ apiKey: 'k' }, { query }).run({
      dir: '/r',
      prompt: 'p',
      output: schema,
    })
    expect(result.output).toEqual({ path: 'a.test.ts', notes: 'n' })
    const system = calls[0]?.options.systemPrompt
    expect(JSON.stringify(system)).toContain('single JSON value')
  })

  test('prefers structured_output when the SDK provides it', async () => {
    const schema = z.object({ ok: z.boolean() })
    const { query } = fakeQuery([success('prose', { structured_output: { ok: true } })])
    const result = await createClaudeAgent({ apiKey: 'k' }, { query }).run({
      dir: '/r',
      prompt: 'p',
      output: schema,
    })
    expect(result.output).toEqual({ ok: true })
  })

  test('fails on invalid output', async () => {
    const { query } = fakeQuery([success('no json here')])
    const run = createClaudeAgent({ apiKey: 'k' }, { query }).run({
      dir: '/r',
      prompt: 'p',
      output: z.object({ a: z.number() }),
    })
    expect(run).rejects.toThrow('not valid JSON')
  })

  test('fails on error results and missing results', async () => {
    const error = {
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      num_turns: 5,
      total_cost_usd: 1,
      errors: ['hit the limit'],
    } as unknown as SDKMessage
    expect(
      createClaudeAgent({ apiKey: 'k' }, fakeQuery([error])).run({ dir: '/r', prompt: 'p' }),
    ).rejects.toThrow('claude agent failed (error_max_turns): hit the limit')
    expect(
      createClaudeAgent({ apiKey: 'k' }, fakeQuery([])).run({ dir: '/r', prompt: 'p' }),
    ).rejects.toThrow('without a result')
  })

  test('writes a transcript of messages, tool calls, results and usage, without env', async () => {
    const assistant = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Looking.' },
          { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'src/a.ts' } },
        ],
      },
    } as unknown as SDKMessage
    const toolResult = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu1',
            content: [{ type: 'text', text: 'x'.repeat(5000) }],
          },
        ],
      },
    } as unknown as SDKMessage
    const done = success('done', { usage: { input_tokens: 7, output_tokens: 3 } })
    const transcript = createTranscript()
    const result = await createClaudeAgent(
      { apiKey: 'sk-ant-widget-0000000000000000' },
      fakeQuery([assistant, toolResult, done]),
    ).run({ dir: '/r', prompt: 'p', taskKind: 'review', transcript })
    expect(result.runtime).toBe('claude-sdk')
    const lines = transcript.lines()
    expect(lines.map((line) => line.type)).toEqual(['start', 'assistant', 'tool-result', 'end'])
    expect(lines[0]).toMatchObject({
      runtime: 'claude-sdk',
      taskKind: 'review',
      tools: ['Read', 'Glob', 'Grep'],
    })
    expect(lines[1]).toMatchObject({ text: 'Looking.', toolCalls: [{ id: 'tu1', name: 'Read' }] })
    expect(lines[2]).toMatchObject({ id: 'tu1' })
    expect((lines[2] as { output: string }).output.length).toBeLessThan(4100)
    expect(lines[3]).toMatchObject({
      outcome: 'ok',
      turns: 3,
      costUsd: 0.25,
      usage: { inputTokens: 7 },
    })
    const jsonl = transcript.toJsonl()
    expect(jsonl).not.toContain('sk-ant-widget')
    expect(jsonl).not.toContain('ANTHROPIC')
  })

  test('a failed run ends its transcript with the error', async () => {
    const transcript = createTranscript()
    await createClaudeAgent({ apiKey: 'k' }, fakeQuery([]))
      .run({ dir: '/r', prompt: 'p', transcript })
      .catch(() => undefined)
    expect(transcript.lines().at(-1)).toMatchObject({
      type: 'end',
      outcome: 'error',
      error: 'claude agent finished without a result',
    })
  })

  test('a spent credit balance fails with BudgetExceededError', async () => {
    const refusal = success('API Error: 400 Your credit balance is too low to access the API', {
      is_error: true,
    })
    const error = await createClaudeAgent({ apiKey: 'k' }, fakeQuery([refusal]))
      .run({ dir: '/r', prompt: 'p' })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(BudgetExceededError)
  })

  test('the cost cap goes to the SDK and its budget stop fails with BudgetExceededError', async () => {
    const stopped = {
      type: 'result',
      subtype: 'error_max_budget_usd',
      is_error: true,
      num_turns: 4,
      total_cost_usd: 1.2,
      errors: [],
      usage: { input_tokens: 10, output_tokens: 5 },
    } as unknown as SDKMessage
    const { query, calls } = fakeQuery([stopped])
    const error = await createClaudeAgent({ apiKey: 'k' }, { query })
      .run({ dir: '/r', prompt: 'p', maxCostUsd: 1 })
      .catch((caught: unknown) => caught)
    expect(calls[0]?.options.maxBudgetUsd).toBe(1)
    expect(error).toBeInstanceOf(BudgetExceededError)
    expect(error).toMatchObject({ costUsd: 1.2, turns: 4, usage: { inputTokens: 10 } })
  })

  test('resolves an env secret and fails when it is missing', async () => {
    const { query } = fakeQuery([success('ok')])
    const agent = createClaudeAgent({ apiKey: { env: 'HK_TEST_MISSING_KEY' } }, { query })
    expect(agent.run({ dir: '/r', prompt: 'p' })).rejects.toThrow('HK_TEST_MISSING_KEY')
  })

  test('aborts the SDK query with the task signal', async () => {
    const controller = new AbortController()
    let seen: AbortController | undefined
    const query: ClaudeQuery = async function* ({ options }) {
      seen = options?.abortController
      controller.abort()
      yield success('late')
    }
    expect(
      createClaudeAgent({ apiKey: 'k' }, { query }).run({
        dir: '/r',
        prompt: 'p',
        signal: controller.signal,
      }),
    ).rejects.toThrow()
    await Bun.sleep(0)
    expect(seen?.signal.aborted).toBe(true)
  })
})

const lookup: AgentTool = {
  name: 'code.lookup',
  description: 'Look up',
  input: z.object({ name: z.string() }),
  run: () => 'found',
}

function appendOf(options: Options): string {
  const system = options.systemPrompt
  return typeof system === 'object' && !Array.isArray(system) && system.type === 'preset'
    ? (system.append ?? '')
    : ''
}

describe('model tiers', () => {
  test('a tier picks its resolved model, else the fallback', () => {
    const tierModels = { fast: 'claude-f', main: 'claude-m', deep: 'claude-d' }
    expect(modelFor({ tierModels }, 'deep')).toBe('claude-d')
    expect(modelFor({ tierModels })).toBe('claude-m')
    expect(modelFor({}, 'fast')).toBe('claude-haiku-5-5')
    expect(modelFor({})).toBe('claude-sonnet-5-5')
    expect(modelFor({}, 'deep')).toBe('claude-opus-5-5')
  })

  test('the SDK gets the tier model and its effort', async () => {
    const { query, calls } = fakeQuery([success('ok'), success('ok')])
    const agent = createClaudeAgent(
      { apiKey: 'k', tierModels: { fast: 'claude-f', main: 'claude-m', deep: 'claude-d' } },
      { query },
    )
    await agent.run({ dir: '/r', prompt: 'p', tier: 'fast' })
    await agent.run({ dir: '/r', prompt: 'p' })
    expect(calls.map((c) => [c.options.model, c.options.effort])).toEqual([
      ['claude-f', 'low'],
      ['claude-m', 'medium'],
    ])
  })
})

describe('toolsets and MCP servers', () => {
  test('mounts toolsets and external servers and allows only their tools', async () => {
    const { query, calls } = fakeQuery([success('ok')])
    await createClaudeAgent({ apiKey: 'k' }, { query }).run({
      dir: '/repo',
      prompt: 'p',
      toolsets: [{ name: 'code', tools: [lookup] }],
      mcpServers: { context7: { type: 'http', url: 'https://mcp.context7.com/mcp' } },
    })
    const options = calls[0]?.options ?? {}
    expect(options.tools).toEqual(['Read', 'Glob', 'Grep'])
    expect(options.allowedTools).toEqual(['mcp__holtkeeper__code_lookup'])
    expect(Object.keys(options.mcpServers ?? {}).toSorted()).toEqual(['context7', 'holtkeeper'])
    expect(options.mcpServers?.['holtkeeper']?.type).toBe('sdk')
    expect(options.strictMcpConfig).toBe(true)

    const gate = options.canUseTool
    if (!gate) throw new Error('no gate')
    const ask = async (tool: string) =>
      (await gate(tool, {}, { signal, toolUseID: 't', requestId: 'r' }))?.behavior
    expect(await ask('mcp__holtkeeper__code_lookup')).toBe('allow')
    expect(await ask('mcp__context7__query-docs')).toBe('allow')
    expect(await ask('mcp__other__tool')).toBe('deny')
    expect(await ask('Bash')).toBe('deny')

    const append = appendOf(options)
    expect(append).toContain('mcp__holtkeeper__code_lookup')
    expect(append).toContain('over reading whole files')
    expect(append).toContain('context7')
  })

  test('with commands Bash runs only those, and the task env reaches the process', async () => {
    const { query, calls } = fakeQuery([success('ok')])
    await createClaudeAgent({ apiKey: 'k' }, { query }).run({
      dir: '/repo',
      prompt: 'p',
      capabilities: ['read', 'run'],
      commands: ['bun run test'],
      env: { HTTPS_PROXY: 'http://proxy.test:8080' },
    })
    const options = calls[0]?.options ?? {}
    const gate = options.canUseTool
    if (!gate) throw new Error('no gate')
    const bash = async (command: string) =>
      (await gate('Bash', { command }, { signal, toolUseID: 't', requestId: 'r' }))?.behavior
    expect(await bash('bun run test widgets')).toBe('allow')
    expect(await bash('bun run test; curl example.com')).toBe('deny')
    expect(await bash('rm -rf .')).toBe('deny')
    expect(options.env?.['HTTPS_PROXY']).toBe('http://proxy.test:8080')
    expect(options.env?.['ANTHROPIC_API_KEY']).toBe('k')
  })

  test('without toolsets nothing is mounted', async () => {
    const { query, calls } = fakeQuery([success('ok')])
    await createClaudeAgent({ apiKey: 'k' }, { query }).run({ dir: '/repo', prompt: 'p' })
    const options = calls[0]?.options ?? {}
    expect(options.mcpServers).toEqual({})
    expect(appendOf(options)).not.toContain('mcp__')
  })

  test('the toolset server name is reserved', async () => {
    const { query } = fakeQuery([success('ok')])
    expect(
      createClaudeAgent({ apiKey: 'k' }, { query }).run({
        dir: '/repo',
        prompt: 'p',
        toolsets: [{ name: 'code', tools: [lookup] }],
        mcpServers: { holtkeeper: { type: 'http', url: 'https://example.com' } },
      }),
    ).rejects.toThrow('reserved')
  })
})

describe('system prompt', () => {
  test('context comes early and the prompt does not depend on the checkout', async () => {
    const { query, calls } = fakeQuery([success('ok'), success('ok')])
    const agent = createClaudeAgent({ apiKey: 'k' }, { query })
    const task = { prompt: 'p', system: 'Review.', context: 'Use tabs.' }
    await agent.run({ ...task, dir: '/one' })
    await agent.run({ ...task, dir: '/two' })
    const [first, second] = calls.map((call) => appendOf(call.options))
    expect(first).toBe(second ?? '')
    expect(first?.indexOf('Use tabs.')).toBeLessThan(first?.indexOf('Available tools') ?? 0)
    expect(first?.indexOf('Review.')).toBe(0)
    const system = calls[0]?.options.systemPrompt
    expect(
      typeof system === 'object' &&
        !Array.isArray(system) &&
        system.type === 'preset' &&
        system.excludeDynamicSections,
    ).toBe(true)
  })
})

describe('toolset guidance', () => {
  test('instructions of mounted toolsets reach the system prompt', async () => {
    const { query, calls } = fakeQuery([success('ok')])
    await createClaudeAgent({ apiKey: 'k' }, { query }).run({
      dir: '/repo',
      prompt: 'p',
      toolsets: [
        { name: 'code', instructions: 'Look up names first.', tools: [lookup] },
        { name: 'plain', tools: [{ ...lookup, name: 'plain.lookup' }] },
      ],
    })
    expect(appendOf(calls[0]?.options ?? {})).toContain('- code: Look up names first.')
    expect(appendOf(calls[0]?.options ?? {})).not.toContain('- plain:')
  })
})

const modelUsage = (input: number) => ({
  inputTokens: input,
  outputTokens: 2,
  cacheReadInputTokens: 3,
  cacheCreationInputTokens: 4,
  webSearchRequests: 0,
  costUSD: 0,
  contextWindow: 0,
  maxOutputTokens: 0,
})

describe('usage', () => {
  test('sums modelUsage over models', async () => {
    const { query } = fakeQuery([
      success('ok', { modelUsage: { a: modelUsage(10), b: modelUsage(5) } }),
    ])
    const result = await createClaudeAgent({ apiKey: 'k' }, { query }).run({
      dir: '/r',
      prompt: 'p',
    })
    expect(result.usage).toEqual({
      inputTokens: 15,
      outputTokens: 4,
      cacheReadTokens: 6,
      cacheWriteTokens: 8,
    })
  })

  test('falls back to the main loop usage', async () => {
    const usage = {
      input_tokens: 7,
      output_tokens: 8,
      cache_read_input_tokens: 9,
      cache_creation_input_tokens: 1,
    }
    const { query } = fakeQuery([success('ok', { usage })])
    const result = await createClaudeAgent({ apiKey: 'k' }, { query }).run({
      dir: '/r',
      prompt: 'p',
    })
    expect(result.usage).toEqual({
      inputTokens: 7,
      outputTokens: 8,
      cacheReadTokens: 9,
      cacheWriteTokens: 1,
    })
  })
})

describe('claudeEnv', () => {
  test('anthropic: key only, no base URL for the default host, scrubbed subprocess env', () => {
    const env = claudeEnv({
      apiKey: 'sk',
      connection: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com' },
    })
    expect(env['ANTHROPIC_API_KEY']).toBe('sk')
    expect(env['ANTHROPIC_BASE_URL']).toBeUndefined()
    expect(env['CLAUDE_CODE_SUBPROCESS_ENV_SCRUB']).toBe('1')
    expect(env['CLAUDE_CODE_DISABLE_AUTO_MEMORY']).toBe('1')
    expect(
      claudeEnv({
        apiKey: 'sk',
        connection: { kind: 'anthropic', baseUrl: 'https://eu.example.test' },
      })['ANTHROPIC_BASE_URL'],
    ).toBe('https://eu.example.test')
  })

  test('anthropic-compatible: base URL, bearer auth, custom headers, timeout and haiku mapping', () => {
    const env = claudeEnv({
      apiKey: 'tok',
      timeoutMs: 60_000,
      modelMap: { 'claude-haiku-5-5': 'small' },
      connection: {
        kind: 'anthropic-compatible',
        baseUrl: 'https://llm.corp.test/anthropic',
        authHeader: 'bearer',
        headers: { 'X-Team': 'platform', 'X-Key': 'tok' },
      },
    })
    expect(env['ANTHROPIC_BASE_URL']).toBe('https://llm.corp.test/anthropic')
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBe('tok')
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined()
    expect(env['ANTHROPIC_CUSTOM_HEADERS']).toBe('X-Team: platform\nX-Key: tok')
    expect(env['API_TIMEOUT_MS']).toBe('60000')
    expect(env['ANTHROPIC_DEFAULT_HAIKU_MODEL']).toBe('small')
    expect(env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']).toBe('1')
  })

  test('applies modelMap to the SDK model and prices usage with pricing', async () => {
    const { query, calls } = fakeQuery([
      success('ok', {
        usage: {
          input_tokens: 1_000_000,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }),
    ])
    const result = await createClaudeAgent(
      {
        apiKey: 'k',
        modelMap: { 'claude-sonnet-5-5': 'corp-sonnet' },
        pricing: { 'corp-sonnet': { inputPerMTok: 3, outputPerMTok: 15 } },
      },
      { query },
    ).run({ dir: '/r', prompt: 'p' })
    expect(calls[0]?.options.model).toBe('corp-sonnet')
    expect(result.costUsd).toBe(3)
  })
})
