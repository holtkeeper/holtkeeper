import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { APICallError, type LanguageModelV4GenerateResult } from '@ai-sdk/provider'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'

import {
  AI_SDK_PACKAGES,
  aiSdkLanguageModel,
  createAiSdkAgent,
  isSupportedProvider,
} from './ai-sdk.ts'
import { BudgetExceededError } from './errors.ts'
import { AI_SDK_PACKAGE_NAMES } from './provider.ts'
import { createTranscript } from './transcript.ts'

let dir = ''

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = ''
})

async function checkout() {
  dir = await mkdtemp(join(tmpdir(), 'hk-ai-sdk-'))
  await mkdir(join(dir, 'src'))
  await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1\n')
  return dir
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return 'resolved'
}

const usage = {
  inputTokens: { total: 1000, noCache: 800, cacheRead: 200, cacheWrite: 0 },
  outputTokens: { total: 100, text: 100, reasoning: 0 },
}

const say = (text: string): LanguageModelV4GenerateResult => ({
  content: [{ type: 'text', text }],
  finishReason: { unified: 'stop', raw: 'stop' },
  usage,
  warnings: [],
})

const call = (toolName: string, input: Record<string, unknown>): LanguageModelV4GenerateResult => ({
  content: [
    { type: 'tool-call', toolCallId: crypto.randomUUID(), toolName, input: JSON.stringify(input) },
  ],
  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
  usage,
  warnings: [],
})

const scripted = (...results: LanguageModelV4GenerateResult[]) => {
  const model = new MockLanguageModelV4({ doGenerate: results })
  const ids: string[] = []
  return {
    model,
    ids,
    languageModel: (id: string) => {
      ids.push(id)
      return model
    },
  }
}

const marked = (message: { providerOptions?: Record<string, unknown> }) =>
  JSON.stringify(message.providerOptions ?? {}).includes('"cacheControl":{"type":"ephemeral"}')

const on = (model: string) => ({ fast: model, main: model, deep: model })

const lastToolOutput = (model: MockLanguageModelV4) =>
  JSON.stringify(model.doGenerateCalls.at(-1)?.prompt.at(-1))

describe('createAiSdkAgent', () => {
  test('runs tools in the checkout, runs the tier model at its effort, sums usage and prices it', async () => {
    const { model, ids, languageModel } = scripted(
      call('read_file', { path: 'src/a.ts' }),
      say('done'),
    )
    const agent = createAiSdkAgent({
      languageModel,
      tierModels: { fast: 'quick', main: 'smart', deep: 'wise' },
      modelMap: { smart: 'vendor/smart-1' },
      pricing: { 'vendor/smart-1': { inputPerMTok: 1, outputPerMTok: 10, cacheReadPerMTok: 0.1 } },
    })
    const result = await agent.run({ dir: await checkout(), prompt: 'look', taskKind: 'review' })
    expect(ids).toEqual(['vendor/smart-1'])
    expect(model.doGenerateCalls[0]?.reasoning).toBe('medium')
    expect(result).toMatchObject({
      text: 'done',
      turns: 2,
      usage: { inputTokens: 1600, outputTokens: 200, cacheReadTokens: 400, cacheWriteTokens: 0 },
    })
    expect(result.costUsd).toBeCloseTo(1600 / 1e6 + 2000 / 1e6 + 40 / 1e6, 10)
    expect(lastToolOutput(model)).toContain('export const a = 1')
    const tools = model.doGenerateCalls[0]?.tools?.map((t) => t.name)
    expect(tools).toEqual(['read_file', 'glob', 'grep'])
  })

  test('writes a transcript of every step, tool call and result', async () => {
    const { languageModel } = scripted(call('read_file', { path: 'src/a.ts' }), say('done'))
    const transcript = createTranscript()
    const agent = createAiSdkAgent({ languageModel, tierModels: on('m') })
    const result = await agent.run({ dir: await checkout(), prompt: 'look', transcript })
    expect(result.runtime).toBe('ai-sdk')
    const lines = transcript.lines()
    expect(lines.map((line) => line.type)).toEqual([
      'start',
      'assistant',
      'tool-result',
      'assistant',
      'end',
    ])
    expect(lines[0]).toMatchObject({ runtime: 'ai-sdk', model: 'm', prompt: 'look' })
    expect(lines[1]).toMatchObject({
      toolCalls: [{ name: 'read_file', input: { path: 'src/a.ts' } }],
    })
    expect(lines[2]).toMatchObject({ name: 'read_file' })
    expect((lines[2] as { output: string }).output).toContain('export const a = 1')
    expect(lines[3]).toMatchObject({ text: 'done' })
    expect(lines[4]).toMatchObject({ outcome: 'ok', turns: 2, usage: { outputTokens: 200 } })
  })

  test('tool errors and invalid arguments go back to the model, not out of the run', async () => {
    const { model, languageModel } = scripted(
      call('read_file', { path: '../outside' }),
      call('read_file', {}),
      say('ok'),
    )
    const agent = createAiSdkAgent({ languageModel, tierModels: on('m') })
    await agent.run({ dir: await checkout(), prompt: 'p' })
    const prompts = model.doGenerateCalls.map((c) => JSON.stringify(c.prompt.at(-1)))
    expect(prompts[1]).toContain('error:')
    expect(prompts[2]).toContain('error: invalid arguments: path')
  })

  test('structured output is parsed, with one retry for an invalid answer', async () => {
    const { languageModel } = scripted(say('not json'), say('{"score": 3}'))
    const agent = createAiSdkAgent({ languageModel, tierModels: on('m') })
    const result = await agent.run({
      dir: await checkout(),
      prompt: 'rate',
      output: z.object({ score: z.number() }),
    })
    expect(result.output).toEqual({ score: 3 })
    expect(result.turns).toBe(2)
  })

  test('marks the system prompt and only the newest message as Anthropic cache breakpoints', async () => {
    const { model, languageModel } = scripted(
      call('glob', { pattern: '*' }),
      call('glob', { pattern: '*' }),
      say('done'),
    )
    await createAiSdkAgent({ languageModel, tierModels: on('m') }).run({
      dir: await checkout(),
      prompt: 'p',
    })
    for (const { prompt } of model.doGenerateCalls) {
      const [system, ...rest] = prompt
      expect(system?.role).toBe('system')
      expect(marked(system ?? {})).toBeTrue()
      expect(rest.map(marked)).toEqual(rest.map((_, i) => i === rest.length - 1))
    }
    expect(model.doGenerateCalls.at(-1)?.prompt.length).toBe(6)
  })

  test('structured output never forces a tool or a response format', async () => {
    const { model, languageModel } = scripted(say('{"score": 3}'))
    await createAiSdkAgent({ languageModel, tierModels: on('m') }).run({
      dir: await checkout(),
      prompt: 'rate',
      output: z.object({ score: z.number() }),
    })
    const [request] = model.doGenerateCalls
    expect(request?.toolChoice?.type ?? 'auto').toBe('auto')
    expect(request?.responseFormat?.type ?? 'text').toBe('text')
  })

  test('a spent budget fails with BudgetExceededError', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({
          message: 'Payment Required',
          url: 'https://llm.test/v1/messages',
          requestBodyValues: {},
          statusCode: 402,
          responseBody: '{"error":{"code":"insufficient_funds","message":"Top up"}}',
        })
      },
    })
    const error = await createAiSdkAgent({ languageModel: () => model, tierModels: on('m') })
      .run({ dir: await checkout(), prompt: 'p' })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(BudgetExceededError)
    expect(error).toMatchObject({ httpStatus: 402, code: 'insufficient_funds' })
  })

  test('stops the loop once the run reaches its cost cap', async () => {
    const { model, languageModel } = scripted(
      call('glob', { pattern: '*' }),
      call('glob', { pattern: '*' }),
      call('glob', { pattern: '*' }),
      say('done'),
    )
    const agent = createAiSdkAgent({
      languageModel,
      tierModels: on('m'),
      pricing: { m: { inputPerMTok: 1, outputPerMTok: 10, cacheReadPerMTok: 0.1 } },
    })
    const error = await agent
      .run({ dir: await checkout(), prompt: 'p', maxCostUsd: 0.003 })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(BudgetExceededError)
    expect(error).toMatchObject({ turns: 2, usage: { inputTokens: 1600, outputTokens: 200 } })
    expect((error as BudgetExceededError).costUsd).toBeCloseTo(0.00364, 10)
    expect(model.doGenerateCalls.length).toBe(2)
  })

  test('an answer that crosses the cost cap is still returned', async () => {
    const { languageModel } = scripted(say('done'))
    const agent = createAiSdkAgent({
      languageModel,
      tierModels: on('m'),
      pricing: { m: { inputPerMTok: 1, outputPerMTok: 10 } },
    })
    const result = await agent.run({ dir: await checkout(), prompt: 'p', maxCostUsd: 0.0001 })
    expect(result.text).toBe('done')
  })

  test('a deep task runs the deep model at high effort', async () => {
    const { model, ids, languageModel } = scripted(say('ok'))
    const agent = createAiSdkAgent({
      languageModel,
      tierModels: { fast: 'quick', main: 'smart', deep: 'wise' },
    })
    await agent.run({ dir: await checkout(), prompt: 'p', tier: 'deep' })
    expect(ids).toEqual(['wise'])
    expect(model.doGenerateCalls[0]?.reasoning).toBe('high')
  })

  test('stops at the turn limit', async () => {
    const { languageModel } = scripted(
      call('glob', { pattern: '*' }),
      call('glob', { pattern: '*' }),
    )
    const agent = createAiSdkAgent({ languageModel, tierModels: on('m'), maxTurns: 2 })
    expect(await failure(agent.run({ dir: await checkout(), prompt: 'p' }))).toContain(
      'error_max_turns',
    )
  })
})

describe('aiSdkLanguageModel', () => {
  test('every shipped package builds a model without a network call', () => {
    expect([...AI_SDK_PACKAGES].toSorted()).toEqual([...AI_SDK_PACKAGE_NAMES].toSorted())
    for (const pkg of AI_SDK_PACKAGES) {
      const model = aiSdkLanguageModel(
        {
          package: pkg,
          name: 'test',
          secret: 'key',
          baseUrl: 'https://llm.test/v1',
          settings: {
            region: 'us-east-1',
            project: 'p',
            location: 'us-central1',
            resourceName: 'r',
          },
        },
        'some-model',
      )
      expect(typeof model === 'string' ? model : model.modelId).toBe('some-model')
    }
  })

  test('OpenAI-compatible needs a base URL; unknown packages are refused', () => {
    expect(() =>
      aiSdkLanguageModel({ package: '@ai-sdk/openai-compatible', name: 'x', secret: 'k' }, 'm'),
    ).toThrow('needs a base URL')
    expect(() => aiSdkLanguageModel({ package: 'left-pad', name: 'x', secret: 'k' }, 'm')).toThrow(
      'not available',
    )
  })

  test('catalog providers are supported by package or by an OpenAI-compatible API', () => {
    expect(isSupportedProvider({ package: '@ai-sdk/groq' })).toBeTrue()
    expect(isSupportedProvider({ package: 'venice-ai-sdk-provider' })).toBeFalse()
    expect(
      isSupportedProvider({ package: 'venice-ai-sdk-provider', api: 'https://v.test' }),
    ).toBeTrue()
  })
})
