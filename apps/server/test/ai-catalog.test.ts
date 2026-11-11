import { beforeEach, describe, expect, test } from 'bun:test'

import {
  type AiCatalog,
  aiProviderOptionsValidator,
  aiProviderOptionsValidatorFor,
} from '@holtkeeper/agent'
import type {
  AiCatalogProviderList,
  CredentialTestResult,
  CredentialView,
  ProviderModelList,
} from '@holtkeeper/api'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { MockLanguageModelV4 } from 'ai/test'

import { createApp } from '../src/app.ts'

const config = parseConfig({ forges: {}, groups: {} })

const catalog: AiCatalog = {
  providers: async () => [
    {
      id: 'openrouter',
      name: 'OpenRouter',
      package: '@openrouter/ai-sdk-provider',
      env: ['OPENROUTER_API_KEY'],
      models: [
        {
          id: 'openai/gpt-5',
          toolCall: true,
          reasoning: true,
          pricing: { inputPerMTok: 1.25, outputPerMTok: 10 },
        },
        { id: 'embed', toolCall: false, reasoning: false },
        ...['haiku', 'sonnet', 'opus'].map((family) => ({
          id: `anthropic/claude-${family}-5.5`,
          toolCall: true,
          reasoning: true,
        })),
      ],
    },
    {
      id: 'munito',
      name: 'Munito AI',
      package: 'munito-ai-sdk',
      api: 'https://api.munito.test/v1',
      env: [],
      models: [],
    },
    { id: 'closed', name: 'Closed', package: 'closed-ai-sdk', env: [], models: [] },
  ],
}

let store: Store
const prompts: string[] = []

const setup = (
  options: { aiCatalog?: AiCatalog; fail?: boolean; probeFetch?: typeof fetch } = {
    aiCatalog: catalog,
  },
) => {
  const vault = aesVault('v'.repeat(32))
  return createApp({
    config,
    auth: noAuth(),
    store,
    vault,
    credentials: createCredentialService({
      credentials: store.credentials,
      vault,
      validateOptions: aiProviderOptionsValidator,
    }),
    settings: [],
    analyses: [],
    ...(options.aiCatalog && { aiCatalog: options.aiCatalog }),
    ...(options.probeFetch && { probeFetch: options.probeFetch }),
    languageModel: () =>
      new MockLanguageModelV4({
        doGenerate: async (call) => {
          prompts.push(JSON.stringify(call.prompt))
          if (options.fail) throw new Error('401 invalid key')
          return {
            content: [{ type: 'text', text: 'OK' }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
            warnings: [],
          }
        },
      }),
    now: () => new Date('2026-10-30T12:00:00.000Z'),
  })
}

const send = (app: ReturnType<typeof setup>, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const createProvider = async (app: ReturnType<typeof setup>, options: Record<string, unknown>) =>
  (await (
    await send(app, 'POST', '/api/credentials', {
      name: 'OpenRouter',
      kind: 'ai-sdk',
      url: 'https://openrouter.ai/api/v1',
      secret: 'sk-or',
      scope: { all: true },
      options,
    })
  ).json()) as CredentialView

beforeEach(() => {
  store = memoryStore()
  prompts.length = 0
})

describe('AI provider plugins', () => {
  test('a closed package becomes available once a plugin provides it', async () => {
    const plugin = {
      package: 'closed-ai-sdk',
      languageModel: () => new MockLanguageModelV4(),
    }
    const app = createApp({
      config,
      auth: noAuth(),
      store,
      vault: aesVault('v'.repeat(32)),
      credentials: createCredentialService({
        credentials: store.credentials,
        vault: aesVault('v'.repeat(32)),
        validateOptions: aiProviderOptionsValidatorFor([plugin]),
      }),
      settings: [],
      analyses: [],
      aiCatalog: catalog,
      aiProviders: [plugin],
      now: () => new Date('2026-10-30T12:00:00.000Z'),
    })
    const list = (await (await app.request('/api/ai/providers')).json()) as AiCatalogProviderList
    expect(list.packages).toContain('closed-ai-sdk')
    expect(list.providers.find((p) => p.id === 'closed')?.package).toBe('closed-ai-sdk')
    const created = await send(app, 'POST', '/api/credentials', {
      name: 'Closed',
      kind: 'ai-sdk',
      url: 'https://closed.test',
      secret: 'sk',
      scope: { all: true },
      options: { provider: 'closed', package: 'closed-ai-sdk' },
    })
    expect(created.status).toBe(201)
  })
})

describe('AI catalog', () => {
  test('lists the providers Holtkeeper can talk to, with their tool-calling models counted', async () => {
    const list = (await (
      await setup().request('/api/ai/providers')
    ).json()) as AiCatalogProviderList
    expect(list.providers).toEqual([
      {
        id: 'munito',
        name: 'Munito AI',
        package: '@ai-sdk/openai-compatible',
        api: 'https://api.munito.test/v1',
        env: [],
        toolModels: 0,
      },
      {
        id: 'openrouter',
        name: 'OpenRouter',
        package: '@openrouter/ai-sdk-provider',
        env: ['OPENROUTER_API_KEY'],
        toolModels: 4,
      },
    ])
    expect(list.packages).toContain('@ai-sdk/openai-compatible')

    const models = (await (
      await setup().request('/api/ai/providers/openrouter/models')
    ).json()) as ProviderModelList
    expect(models.models.map((m) => [m.id, m.toolCall])).toEqual([
      ['openai/gpt-5', true],
      ['embed', false],
      ['anthropic/claude-haiku-5.5', true],
      ['anthropic/claude-sonnet-5.5', true],
      ['anthropic/claude-opus-5.5', true],
    ])
    expect((await setup().request('/api/ai/providers/nope/models')).status).toBe(404)
  })

  test('reports a catalog that cannot load instead of failing', async () => {
    const down: AiCatalog = { providers: async () => Promise.reject(new Error('offline')) }
    const list = (await (
      await setup({ aiCatalog: down }).request('/api/ai/providers')
    ).json()) as AiCatalogProviderList
    expect(list).toMatchObject({ providers: [], error: 'offline' })
    expect((await setup({}).request('/api/ai/providers')).status).toBe(200)
  })
})

describe('ai-sdk credentials', () => {
  test('validate options, list catalog models and test the main tier model', async () => {
    const app = setup()
    const bad = await send(app, 'POST', '/api/credentials', {
      name: 'x',
      kind: 'ai-sdk',
      url: 'https://x.test',
      secret: 's',
      scope: { all: true },
      options: { provider: 'x', package: 'left-pad' },
    })
    expect(bad.status).toBe(400)

    const credential = await createProvider(app, {
      provider: 'openrouter',
      package: '@openrouter/ai-sdk-provider',
    })
    const models = (await (
      await app.request(`/api/credentials/${credential.id}/models`)
    ).json()) as ProviderModelList
    expect(models.models[0]).toMatchObject({ id: 'openai/gpt-5', source: 'catalog' })

    const tested = (await (
      await send(app, 'POST', `/api/credentials/${credential.id}/test`)
    ).json()) as CredentialTestResult
    expect(tested).toMatchObject({ ok: true, model: 'anthropic/claude-sonnet-5.5', reply: 'OK' })
    expect(prompts[0]).toContain('Reply with the single word OK.')
  })

  test('a failing test reports the error', async () => {
    const app = setup({ aiCatalog: catalog, fail: true })
    const credential = await createProvider(app, {
      provider: 'openrouter',
      package: '@openrouter/ai-sdk-provider',
    })
    const failed = (await (
      await send(app, 'POST', `/api/credentials/${credential.id}/test`, { model: 'openai/gpt-5' })
    ).json()) as CredentialTestResult
    expect(failed).toMatchObject({ ok: false, model: 'openai/gpt-5' })
    expect(failed.error).toContain('401 invalid key')
  })
})

describe('Anthropic credential tests', () => {
  test('probe Messages tool use and store the result on the credential', async () => {
    let answer: unknown = {
      content: [{ type: 'tool_use', id: 't', name: 'record_word', input: {} }],
    }
    let status = 200
    const urls: string[] = []
    const app = setup({
      probeFetch: (async (url: string | URL | Request) => {
        urls.push(url instanceof Request ? url.url : url.toString())
        return new Response(JSON.stringify(answer), { status })
      }) as typeof fetch,
    })
    const credential = (await (
      await send(app, 'POST', '/api/credentials', {
        name: 'Gateway',
        kind: 'anthropic-compatible',
        url: 'https://llm.corp.test/anthropic',
        secret: 'gateway-secret-123',
        scope: { all: true },
      })
    ).json()) as CredentialView

    const tested = (await (
      await send(app, 'POST', `/api/credentials/${credential.id}/test`, { model: 'corp-sonnet' })
    ).json()) as CredentialTestResult
    expect(tested).toMatchObject({
      ok: true,
      model: 'corp-sonnet',
      capabilities: { agentLoop: 'ok', checkedAt: '2026-10-30T12:00:00.000Z' },
    })
    expect(urls).toEqual(['https://llm.corp.test/anthropic/v1/messages'])

    status = 529
    answer = { error: { type: 'overloaded_error', message: 'Overloaded' } }
    const busy = (await (
      await send(app, 'POST', `/api/credentials/${credential.id}/test`, { model: 'corp-sonnet' })
    ).json()) as CredentialTestResult
    expect(busy).toMatchObject({
      ok: false,
      error: 'HTTP 529: Overloaded',
      capabilities: { agentLoop: 'ok' },
    })
    status = 200

    answer = { content: [{ type: 'text', text: 'no tools here' }] }
    const failed = (await (
      await send(app, 'POST', `/api/credentials/${credential.id}/test`, { model: 'corp-sonnet' })
    ).json()) as CredentialTestResult
    expect(failed).toMatchObject({ ok: false, capabilities: { agentLoop: 'failed' } })
    const listed = (await (await app.request('/api/credentials')).json()) as {
      credentials: CredentialView[]
    }
    expect(listed.credentials[0]?.capabilities?.agentLoop).toBe('failed')

    const moved = (await (
      await send(app, 'PATCH', `/api/credentials/${credential.id}`, {
        url: 'https://llm.other.test/anthropic',
      })
    ).json()) as CredentialView
    expect(moved.capabilities).toBeUndefined()
  })
})
