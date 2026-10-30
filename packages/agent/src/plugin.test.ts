import { describe, expect, test } from 'bun:test'

import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider'
import { MockLanguageModelV4 } from 'ai/test'

import { type AiSdkConnection, aiSdkLanguageModel, isSupportedProvider } from './ai-sdk.ts'
import type { AiCatalog, CatalogProvider } from './catalog.ts'
import { createAgent, pingAiSdkProvider } from './factory.ts'
import {
  type AiProviderPlugin,
  aiProviderOptionsValidatorFor,
  aiSdkPackages,
  defineAiProvider,
  withPluginCatalogs,
} from './plugin.ts'
import { aiProviderOptionsValidator } from './provider.ts'

const reply: LanguageModelV4GenerateResult = {
  content: [{ type: 'text', text: 'OK' }],
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
  warnings: [],
}

const provider = (id: string, pkg = 'acme-ai-provider'): CatalogProvider => ({
  id,
  name: id,
  package: pkg,
  env: [],
  models: [],
})

function acme(catalog?: AiProviderPlugin['catalog']) {
  const calls: { connection: AiSdkConnection; modelId: string }[] = []
  const plugin = defineAiProvider({
    package: 'acme-ai-provider',
    languageModel: (connection, modelId) => {
      calls.push({ connection, modelId })
      return new MockLanguageModelV4({ doGenerate: async () => reply })
    },
    ...(catalog && { catalog }),
  })
  return { plugin, calls }
}

const fixedCatalog = (providers: CatalogProvider[]): AiCatalog => ({
  providers: async () => providers,
})

describe('packages', () => {
  test('plugins add their package to the shipped ones', () => {
    const { plugin } = acme()
    expect(aiSdkPackages([plugin])).toContain('acme-ai-provider')
    expect(aiSdkPackages([plugin])).toContain('@ai-sdk/openai')
    expect(isSupportedProvider(provider('acme'), [plugin])).toBe(true)
    expect(isSupportedProvider(provider('acme'))).toBe(false)
  })

  test('the validator accepts plugin packages and refuses unknown ones', () => {
    const { plugin } = acme()
    const options = { provider: 'acme', package: 'acme-ai-provider' }
    expect(aiProviderOptionsValidatorFor([plugin])('ai-sdk', options)).toEqual([])
    expect(aiProviderOptionsValidator('ai-sdk', options)).toEqual([
      'options.package: acme-ai-provider is not an available AI SDK package',
    ])
    expect(aiProviderOptionsValidatorFor([plugin])('github', {})).toBeUndefined()
  })
})

describe('language models', () => {
  test('a credential naming the plugin package runs on the plugin', async () => {
    const { plugin, calls } = acme()
    const connection: AiSdkConnection = {
      package: 'acme-ai-provider',
      name: 'acme',
      secret: 'sk_test',
      settings: { region: 'eu' },
    }
    aiSdkLanguageModel(connection, 'acme/fast', [plugin])
    expect(calls).toEqual([{ connection, modelId: 'acme/fast' }])
    expect(() => aiSdkLanguageModel(connection, 'acme/fast')).toThrow(
      'AI SDK package acme-ai-provider is not available',
    )
  })

  test('createAgent and the credential test pass plugins through', async () => {
    const { plugin, calls } = acme()
    const credential = {
      kind: 'ai-sdk',
      url: 'https://acme.test',
      secret: 'sk_test',
      options: { provider: 'acme', package: 'acme-ai-provider', model: 'acme/fast' },
    }
    const agent = createAgent(credential, { plugins: [plugin] })
    const result = await agent.run({ prompt: 'hi', dir: '.' })
    expect(result.text).toBe('OK')
    const ping = await pingAiSdkProvider(credential, 'acme/fast', { plugins: [plugin] })
    expect(ping.text).toBe('OK')
    expect(calls.map((c) => [c.connection.secret, c.modelId])).toEqual([
      ['sk_test', 'acme/fast'],
      ['sk_test', 'acme/fast'],
    ])
  })
})

describe('withPluginCatalogs', () => {
  test('adds plugin providers with their package, replacing base ones of the same id', async () => {
    const { plugin } = acme(() => [provider('acme', 'whatever'), provider('openai', 'x')])
    const catalog = withPluginCatalogs(
      fixedCatalog([provider('openai', '@ai-sdk/openai'), provider('groq', '@ai-sdk/groq')]),
      [plugin],
    )
    expect((await catalog.providers()).map((p) => [p.id, p.package])).toEqual([
      ['acme', 'acme-ai-provider'],
      ['openai', 'acme-ai-provider'],
      ['groq', '@ai-sdk/groq'],
    ])
  })

  test('caches plugin catalogs and keeps the last good copy on failure', async () => {
    let time = 0
    let calls = 0
    const errors: unknown[] = []
    const { plugin } = acme(async () => {
      calls++
      if (calls > 1) throw new Error('down')
      return [provider('acme')]
    })
    const catalog = withPluginCatalogs(fixedCatalog([]), [plugin], {
      ttlMs: 100,
      now: () => time,
      onError: (error) => errors.push(error),
    })
    await catalog.providers()
    await catalog.providers()
    expect(calls).toBe(1)
    time = 200
    expect((await catalog.providers()).map((p) => p.id)).toEqual(['acme'])
    expect(calls).toBe(2)
    expect(errors).toHaveLength(1)
  })

  test('serves plugin providers when the base catalog fails, and fails without them', async () => {
    const failing: AiCatalog = {
      providers: async () => {
        throw new Error('models.dev down')
      },
    }
    const { plugin } = acme(() => [provider('acme')])
    expect((await withPluginCatalogs(failing, [plugin]).providers()).map((p) => p.id)).toEqual([
      'acme',
    ])
    const { plugin: bare } = acme(() => [])
    expect(withPluginCatalogs(failing, [bare]).providers()).rejects.toThrow('models.dev down')
    expect(withPluginCatalogs(failing, [acme().plugin])).toBe(failing)
  })
})
