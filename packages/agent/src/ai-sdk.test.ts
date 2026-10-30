import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'

import {
  AI_SDK_PACKAGES,
  aiSdkLanguageModel,
  createAiSdkAgent,
  isSupportedProvider,
} from './ai-sdk.ts'
import { AI_SDK_PACKAGE_NAMES } from './provider.ts'

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

const lastToolOutput = (model: MockLanguageModelV4) =>
  JSON.stringify(model.doGenerateCalls.at(-1)?.prompt.at(-1))

describe('createAiSdkAgent', () => {
  test('runs tools in the checkout, routes and maps the model, sums usage and prices it', async () => {
    const { model, ids, languageModel } = scripted(
      call('read_file', { path: 'src/a.ts' }),
      say('done'),
    )
    const agent = createAiSdkAgent({
      languageModel,
      model: 'fast',
      models: { review: 'smart' },
      modelMap: { smart: 'vendor/smart-1' },
      pricing: { 'vendor/smart-1': { inputPerMTok: 1, outputPerMTok: 10, cacheReadPerMTok: 0.1 } },
    })
    const result = await agent.run({ dir: await checkout(), prompt: 'look', taskKind: 'review' })
    expect(ids).toEqual(['vendor/smart-1'])
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

  test('tool errors and invalid arguments go back to the model, not out of the run', async () => {
    const { model, languageModel } = scripted(
      call('read_file', { path: '../outside' }),
      call('read_file', {}),
      say('ok'),
    )
    const agent = createAiSdkAgent({ languageModel, model: 'm' })
    await agent.run({ dir: await checkout(), prompt: 'p' })
    const prompts = model.doGenerateCalls.map((c) => JSON.stringify(c.prompt.at(-1)))
    expect(prompts[1]).toContain('error:')
    expect(prompts[2]).toContain('error: invalid arguments: path')
  })

  test('structured output is parsed, with one retry for an invalid answer', async () => {
    const { languageModel } = scripted(say('not json'), say('{"score": 3}'))
    const agent = createAiSdkAgent({ languageModel, model: 'm' })
    const result = await agent.run({
      dir: await checkout(),
      prompt: 'rate',
      output: z.object({ score: z.number() }),
    })
    expect(result.output).toEqual({ score: 3 })
    expect(result.turns).toBe(2)
  })

  test('stops at the turn limit and needs a model', async () => {
    const { languageModel } = scripted(
      call('glob', { pattern: '*' }),
      call('glob', { pattern: '*' }),
    )
    const agent = createAiSdkAgent({ languageModel, model: 'm', maxTurns: 2 })
    expect(await failure(agent.run({ dir: await checkout(), prompt: 'p' }))).toContain(
      'error_max_turns',
    )
    const unrouted = createAiSdkAgent({ languageModel })
    expect(await failure(unrouted.run({ dir: await checkout(), prompt: 'p' }))).toContain(
      'no model configured',
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
