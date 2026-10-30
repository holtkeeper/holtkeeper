import { expect, test } from 'bun:test'

import type { LanguageModelV4 } from '@ai-sdk/provider'
import { aiProviderOptionsValidatorFor } from '@holtkeeper/agent'

import { WAIBEE_PACKAGE, waibee } from './index.ts'

const connection = { package: WAIBEE_PACKAGE, name: 'waibee', secret: 'sk_test' }

test('credentials run on Chat Completions, or on Messages when asked', () => {
  const plugin = waibee({ listModels: async () => [] })
  const chat = plugin.languageModel(connection, 'openai/gpt-5.4-nano') as LanguageModelV4
  expect([chat.provider, chat.modelId]).toEqual(['waibee.chat', 'openai/gpt-5.4-nano'])
  const messages = plugin.languageModel(
    { ...connection, settings: { endpoint: 'messages' } },
    'anthropic/claude-sonnet-4.6',
  ) as LanguageModelV4
  expect([messages.provider, messages.modelId]).toEqual(['waibee.messages', 'claude-sonnet-4-6'])
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
