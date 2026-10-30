import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'
import { z } from 'zod'

import { createOpenAICompatibleAgent, openAICompatibleAgent } from './openai.ts'
import type { Toolset } from './types.ts'

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return 'resolved'
}

interface Request {
  headers: Record<string, string>
  body: {
    model: string
    messages: { role: string; content: string | null; tool_call_id?: string }[]
    tools?: { function: { name: string; parameters: Record<string, unknown> } }[]
    response_format?: unknown
  }
}

type Reply = Record<string, unknown> | ((request: Request) => Record<string, unknown>)

let script: Reply[] = []
const requests: Request[] = []
let server: ReturnType<typeof Bun.serve>
let baseUrl = ''

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const request: Request = {
        headers: Object.fromEntries(req.headers.entries()),
        body: (await req.json()) as Request['body'],
      }
      requests.push(request)
      if (new URL(req.url).pathname !== '/v1/chat/completions')
        return new Response('not found', { status: 404 })
      const next = script.shift()
      if (!next) return new Response('script exhausted', { status: 500 })
      return Response.json(typeof next === 'function' ? next(request) : next)
    },
  })
  baseUrl = `http://127.0.0.1:${server.port}/v1`
})
afterAll(() => server.stop(true))

let dir = ''
afterEach(async () => {
  script = []
  requests.length = 0
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = ''
})

async function checkout() {
  dir = await mkdtemp(join(tmpdir(), 'hk-openai-'))
  await mkdir(join(dir, 'src'))
  await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1\nexport const b = 2\n')
  return dir
}

const usage = {
  prompt_tokens: 100,
  completion_tokens: 20,
  prompt_tokens_details: { cached_tokens: 40 },
}

const say = (content: string) => ({
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage,
})

let callId = 0
const call = (name: string, args: Record<string, unknown>) => ({
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: `call_${++callId}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage,
})

const lastToolResult = (request: Request) =>
  request.body.messages.findLast((message) => message.role === 'tool')?.content ?? ''

describe('openAICompatibleAgent', () => {
  test('sends model, auth, headers and tools, and returns text, turns and usage', async () => {
    const repo = await checkout()
    script = [say('all good')]
    const agent = openAICompatibleAgent({
      baseUrl: `${baseUrl}/`,
      apiKey: 'sk-test',
      headers: { 'X-Team': 'platform' },
      models: { review: 'logical-review' },
      modelMap: { 'logical-review': 'gpt-proxy' },
      pricing: { 'gpt-proxy': { inputPerMTok: 1, outputPerMTok: 10, cacheReadPerMTok: 0.1 } },
    })
    const result = await agent.run({
      dir: repo,
      prompt: 'review',
      system: 'Be brief.',
      taskKind: 'review',
      context: '## Team knowledge',
    })

    expect(agent.name).toBe('openai-compatible')
    expect(result.text).toBe('all good')
    expect(result.turns).toBe(1)
    expect(result.usage).toEqual({
      inputTokens: 60,
      outputTokens: 20,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
    })
    expect(result.costUsd).toBeCloseTo((60 * 1 + 20 * 10 + 40 * 0.1) / 1_000_000)
    const [request] = requests
    expect(request?.headers['authorization']).toBe('Bearer sk-test')
    expect(request?.headers['x-team']).toBe('platform')
    expect(request?.body.model).toBe('gpt-proxy')
    expect(request?.body.tools?.map((tool) => tool.function.name)).toEqual([
      'read_file',
      'glob',
      'grep',
    ])
    const system = request?.body.messages[0]?.content ?? ''
    expect(system.indexOf('Be brief.')).toBeLessThan(system.indexOf('## Team knowledge'))
    expect(system).toContain('Do not modify files.')
    expect(request?.body.messages[1]).toEqual({ role: 'user', content: 'review' })
  })

  test('runs tool calls: read, grep, edit and write inside dir', async () => {
    const repo = await checkout()
    script = [
      call('read_file', { path: 'src/a.ts' }),
      (request) => {
        expect(lastToolResult(request)).toContain('1\texport const a = 1')
        return call('grep', { pattern: 'const b' })
      },
      (request) => {
        expect(lastToolResult(request)).toBe('src/a.ts:2: export const b = 2')
        return call('edit_file', { path: 'src/a.ts', old_string: 'a = 1', new_string: 'a = 3' })
      },
      call('write_file', { path: 'src/new/b.ts', content: 'export {}\n' }),
      call('glob', { pattern: '**/*.ts' }),
      (request) => {
        expect(lastToolResult(request)).toBe('src/a.ts\nsrc/new/b.ts')
        return say('done')
      },
    ]
    const result = await createOpenAICompatibleAgent({ baseUrl }).run({
      dir: repo,
      prompt: 'fix',
      capabilities: ['read', 'search', 'edit'],
    })
    expect(result.turns).toBe(6)
    expect(await readFile(join(repo, 'src', 'a.ts'), 'utf8')).toBe(
      'export const a = 3\nexport const b = 2\n',
    )
    expect(await readFile(join(repo, 'src', 'new', 'b.ts'), 'utf8')).toBe('export {}\n')
    expect(requests[0]?.body.tools?.map((tool) => tool.function.name)).toEqual([
      'read_file',
      'glob',
      'grep',
      'edit_file',
      'write_file',
    ])
  })

  test('denies paths outside dir, symlinks out of it and tools not granted', async () => {
    const repo = await checkout()
    const outside = await mkdtemp(join(tmpdir(), 'hk-outside-'))
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(outside, join(repo, 'link'))
    const results: string[] = []
    const collect = (next: Record<string, unknown>) => (request: Request) => {
      results.push(lastToolResult(request))
      return next
    }
    script = [
      call('read_file', { path: '/etc/passwd' }),
      collect(call('read_file', { path: '../x' })),
      collect(call('read_file', { path: 'link/secret.txt' })),
      collect(call('glob', { pattern: '../**' })),
      collect(call('write_file', { path: 'x.ts', content: '' })),
      collect(call('run_command', { command: 'ls' })),
      collect(say('ok')),
    ]
    try {
      await createOpenAICompatibleAgent({ baseUrl }).run({ dir: repo, prompt: 'p' })
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
    expect(
      results.slice(0, 4).every((text) => text.includes('outside the working directory')),
    ).toBe(true)
    expect(results[4]).toBe('error: write_file is not available for this task')
    expect(results[5]).toBe('error: run_command is not available for this task')
  })

  test('run_command goes through the injected runner', async () => {
    const repo = await checkout()
    const { runner, calls } = createFakeRunner(() => ({
      exitCode: 1,
      stdout: 'FAIL a.test.ts',
      stderr: '',
    }))
    script = [
      call('run_command', { command: 'bun test' }),
      (request) => {
        expect(lastToolResult(request)).toBe('exit code 1\nFAIL a.test.ts')
        return say('tests fail')
      },
    ]
    await createOpenAICompatibleAgent({ baseUrl, runner }).run({
      dir: repo,
      prompt: 'p',
      capabilities: ['run'],
    })
    expect(calls.map((c) => [c.command, c.options.cwd])).toEqual([[['sh', '-c', 'bun test'], repo]])
  })

  test('mounts toolset tools and reports their errors to the model', async () => {
    const repo = await checkout()
    const toolsets: Toolset[] = [
      {
        name: 'code',
        tools: [
          {
            name: 'code.search',
            description: 'search',
            input: z.object({ query: z.string() }),
            run: ({ query }, ctx) => `found ${String(query)} in ${ctx.dir === repo ? 'repo' : '?'}`,
          },
          {
            name: 'code.fail',
            description: 'fails',
            input: z.object({}),
            run: () => {
              throw new Error('boom')
            },
          },
        ],
      },
    ]
    script = [
      call('code_search', { query: 'x' }),
      (request) => {
        expect(lastToolResult(request)).toBe('found x in repo')
        return call('code_fail', {})
      },
      (request) => {
        expect(lastToolResult(request)).toBe('error: boom')
        return call('code_search', { query: 1 })
      },
      (request) => {
        expect(lastToolResult(request)).toStartWith('error: invalid arguments: query:')
        return say('ok')
      },
    ]
    await createOpenAICompatibleAgent({ baseUrl }).run({
      dir: repo,
      prompt: 'p',
      capabilities: [],
      toolsets,
    })
    expect(requests[0]?.body.tools?.map((tool) => tool.function.name)).toEqual([
      'code_search',
      'code_fail',
    ])
    expect(requests[0]?.body.tools?.[0]?.function.parameters['properties']).toEqual({
      query: { type: 'string' },
    })
  })

  test('stops at max turns', async () => {
    const repo = await checkout()
    script = [
      call('glob', { pattern: '*' }),
      call('glob', { pattern: '*' }),
      call('glob', { pattern: '*' }),
    ]
    expect(
      await failure(
        createOpenAICompatibleAgent({ baseUrl, maxTurns: 5 }).run({
          dir: repo,
          prompt: 'p',
          maxTurns: 2,
        }),
      ),
    ).toContain('error_max_turns')
    expect(requests).toHaveLength(2)
  })

  test('parses structured output, asking once more after an invalid answer', async () => {
    const repo = await checkout()
    const schema = z.object({ findings: z.array(z.string()) })
    script = [
      say('I think it is fine'),
      (request) => {
        expect(request.body.messages.at(-1)?.content).toContain('not valid JSON')
        return say('```json\n{"findings":["a"]}\n```')
      },
    ]
    const result = await createOpenAICompatibleAgent({ baseUrl, jsonMode: true }).run({
      dir: repo,
      prompt: 'p',
      output: schema,
    })
    expect(result.output).toEqual({ findings: ['a'] })
    expect(result.turns).toBe(2)
    expect(requests[0]?.body.response_format).toEqual({ type: 'json_object' })
    expect(requests[0]?.body.messages[0]?.content).toContain('"findings"')
  })

  test('throws when the answer stays invalid', async () => {
    const repo = await checkout()
    script = [say('{"findings": 1}'), say('{"findings": 2}')]
    expect(
      await failure(
        createOpenAICompatibleAgent({ baseUrl }).run({
          dir: repo,
          prompt: 'p',
          output: z.object({ findings: z.array(z.string()) }),
        }),
      ),
    ).toContain('does not match the expected shape')
  })

  test('uses a reported cost over pricing, and fails on HTTP errors', async () => {
    const repo = await checkout()
    script = [{ ...say('ok'), usage: { ...usage, cost: 0.5 } }]
    const result = await createOpenAICompatibleAgent({
      baseUrl,
      pricing: { 'claude-opus-5-5': { inputPerMTok: 1, outputPerMTok: 1 } },
    }).run({ dir: repo, prompt: 'p' })
    expect(result.costUsd).toBe(0.5)
    expect(
      await failure(
        createOpenAICompatibleAgent({ baseUrl: `${baseUrl}/missing` }).run({
          dir: repo,
          prompt: 'p',
        }),
      ),
    ).toContain('HTTP 404')
  })

  test('abort stops the loop', async () => {
    const repo = await checkout()
    const controller = new AbortController()
    script = [
      () => {
        controller.abort(new Error('cancelled'))
        return call('glob', { pattern: '*' })
      },
      say('never'),
    ]
    expect(
      await failure(
        createOpenAICompatibleAgent({ baseUrl }).run({
          dir: repo,
          prompt: 'p',
          signal: controller.signal,
        }),
      ),
    ).toContain('cancelled')
  })
})
