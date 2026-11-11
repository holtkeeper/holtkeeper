import { afterEach, describe, expect, test } from 'bun:test'

import type { LanguageModelV4 } from '@ai-sdk/provider'
import {
  BudgetExceededError,
  aiProviderOptionsValidatorFor,
  createAiSdkAgent,
} from '@holtkeeper/agent'

import { WAIBEE_PACKAGE, waibee } from './index.ts'

const connection = { package: WAIBEE_PACKAGE, name: 'waibee', secret: 'sk_test' }

test('Claude models run on Messages, others on Chat Completions, unless the credential says', () => {
  const plugin = waibee({ listModels: async () => [] })
  const route = (modelId: string, settings?: Record<string, unknown>) => {
    const model = plugin.languageModel(
      { ...connection, ...(settings && { settings }) },
      modelId,
    ) as LanguageModelV4
    return [model.provider, model.modelId]
  }
  expect(route('openai/gpt-5.4-nano')).toEqual(['waibee.chat', 'openai/gpt-5.4-nano'])
  expect(route('waibee/auto')).toEqual(['waibee.chat', 'waibee/auto'])
  expect(route('anthropic/claude-sonnet-4.6')).toEqual(['waibee.messages', 'claude-sonnet-4-6'])
  expect(route('anthropic/claude-sonnet-4.6', { endpoint: 'chat' })).toEqual([
    'waibee.chat',
    'anthropic/claude-sonnet-4.6',
  ])
  expect(route('openai/gpt-5.4-nano', { endpoint: 'messages' })[0]).toBe('waibee.messages')
})

const agent = () =>
  createAiSdkAgent({
    languageModel: (id) => waibee({ listModels: async () => [] }).languageModel(connection, id),
    tierModels: {
      fast: 'anthropic/claude-haiku-4.5',
      main: 'anthropic/claude-sonnet-4.6',
      deep: 'anthropic/claude-opus-4.6',
    },
  })

describe('runs on Messages', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  const stubFetch = (respond: () => Response) => {
    const requests: { url: string; body: Record<string, unknown> }[] = []
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: input instanceof Request ? input.url : input.toString(),
          body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
            string,
            unknown
          >,
        })
        return respond()
      },
      { preconnect: realFetch.preconnect },
    )
    return requests
  }

  test('with cache breakpoints on the system prompt and the newest message', async () => {
    const requests = stubFetch(() =>
      Response.json({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 90 },
      }),
    )
    const result = await agent().run({ dir: '.', prompt: 'Summarize the widget.' })
    expect(result.usage?.cacheReadTokens).toBe(90)
    const [request] = requests
    expect(request?.url).toEndWith('/messages')
    expect(JSON.stringify(request?.body.system)).toContain('"cache_control":{"type":"ephemeral"}')
    expect(JSON.stringify(request?.body.messages)).toContain('"cache_control":{"type":"ephemeral"}')
  })

  test('a spent key limit fails with BudgetExceededError', async () => {
    stubFetch(() =>
      Response.json(
        { error: { code: 'insufficient_funds', message: 'Top up the balance' } },
        { status: 402 },
      ),
    )
    const error = await agent()
      .run({ dir: '.', prompt: 'Summarize the widget.' })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(BudgetExceededError)
    expect(error).toMatchObject({ httpStatus: 402, code: 'insufficient_funds' })
  })
})

test('the catalog lists chat models with prices per million tokens', async () => {
  const plugin = waibee({
    listModels: async () => [
      {
        id: 'openai/gpt-5.4-nano',
        name: 'GPT-5.4 Nano',
        class: 'chat',
        contextWindow: 400000,
        input: ['text'],
        output: ['text'],
        features: ['tools'],
        pricing: { input: 0.0000002, output: 0.00000125 },
      },
    ],
  })
  const [provider] = (await plugin.catalog?.()) ?? []
  expect(provider).toMatchObject({ id: 'waibee', name: 'Waibee', env: ['WAIBEE_API_KEY'] })
  expect(provider?.models).toEqual([
    {
      id: 'openai/gpt-5.4-nano',
      name: 'GPT-5.4 Nano',
      toolCall: true,
      reasoning: false,
      contextWindow: 400000,
      pricing: { inputPerMTok: 0.2, outputPerMTok: 1.25 },
    },
  ])
})

test('without a key the catalog is the bundled snapshot', async () => {
  const saved = process.env.WAIBEE_API_KEY
  delete process.env.WAIBEE_API_KEY
  try {
    const [provider] = (await waibee().catalog?.()) ?? []
    expect(provider?.models.length).toBeGreaterThan(10)
  } finally {
    if (saved !== undefined) process.env.WAIBEE_API_KEY = saved
  }
})

test('credentials may name the package once the plugin is added', () => {
  const validate = aiProviderOptionsValidatorFor([waibee()])
  expect(validate('ai-sdk', { provider: 'waibee', package: WAIBEE_PACKAGE })).toEqual([])
})
