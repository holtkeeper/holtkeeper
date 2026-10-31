import { describe, expect, test } from 'bun:test'

import {
  listProviderModels,
  modelCatalog,
  resolveLatestModel,
  resolveLatestRouting,
  resolveProviderRouting,
} from './models.ts'

const listedIds = (ids: string[]) => async () => ({
  models: ids.map((id) => ({ id, source: 'provider' as const })),
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function recordingFetch(respond: (url: string) => Response) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString()
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) })
    return respond(url)
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

describe('listProviderModels', () => {
  test('pages through the Anthropic models API', async () => {
    const { fetch, calls } = recordingFetch((url) =>
      url.includes('after_id')
        ? json({
            data: [{ id: 'claude-haiku-5-5', created_at: '2026-06-01T00:00:00Z' }],
            has_more: false,
          })
        : json({
            data: [
              {
                id: 'claude-opus-5-5',
                display_name: 'Claude Opus 5.5',
                created_at: '2026-09-01T00:00:00Z',
              },
            ],
            has_more: true,
            last_id: 'claude-opus-5-5',
          }),
    )
    const listing = await listProviderModels(
      {
        kind: 'anthropic',
        url: 'https://api.anthropic.com',
        secret: 'sk',
        options: { pricing: { 'claude-opus-5-5': { inputPerMTok: 5, outputPerMTok: 25 } } },
      },
      { fetch },
    )
    expect(listing).toEqual({
      models: [
        {
          id: 'claude-opus-5-5',
          name: 'Claude Opus 5.5',
          createdAt: '2026-09-01T00:00:00.000Z',
          pricing: { inputPerMTok: 5, outputPerMTok: 25 },
          source: 'provider',
        },
        { id: 'claude-haiku-5-5', createdAt: '2026-06-01T00:00:00.000Z', source: 'provider' },
      ],
    })
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/models?limit=1000')
    expect(calls[0]?.headers['x-api-key']).toBe('sk')
    expect(calls[1]?.url).toContain('after_id=claude-opus-5-5')
  })

  test('reads OpenRouter-style prices from an OpenAI-compatible listing', async () => {
    const { fetch, calls } = recordingFetch(() =>
      json({
        data: [
          {
            id: 'gpt-5',
            created: 1_750_000_000,
            pricing: { prompt: '0.00000125', completion: '0.00001' },
          },
          { id: 'gpt-5-mini' },
        ],
      }),
    )
    const listing = await listProviderModels(
      { kind: 'openai-compatible', url: 'https://llm.test/v1/', secret: 'key' },
      { fetch },
    )
    expect(calls[0]?.url).toBe('https://llm.test/v1/models')
    expect(calls[0]?.headers.authorization).toBe('Bearer key')
    expect(listing.models[0]).toEqual({
      id: 'gpt-5',
      createdAt: new Date(1_750_000_000_000).toISOString(),
      pricing: { inputPerMTok: 1.25, outputPerMTok: 10 },
      source: 'provider',
    })
    expect(listing.models[1]).toEqual({ id: 'gpt-5-mini', source: 'provider' })
  })

  test('keeps configured models and reports a failing API', async () => {
    const { fetch } = recordingFetch(() => json({}, 401))
    const listing = await listProviderModels(
      {
        kind: 'anthropic-compatible',
        url: 'https://gw.test',
        secret: 'token',
        options: {
          authHeader: 'bearer',
          model: 'claude-opus@latest',
          modelMap: { 'claude-opus-5-5': 'corp-opus' },
          pricing: { 'claude-opus-5-5': { inputPerMTok: 5, outputPerMTok: 25 } },
        },
      },
      { fetch },
    )
    expect(listing.error).toBe('GET https://gw.test/v1/models?limit=1000: HTTP 401')
    expect(listing.models).toEqual([
      { id: 'corp-opus', source: 'config', pricing: { inputPerMTok: 5, outputPerMTok: 25 } },
    ])
  })

  test('lists only configured models for Bedrock', async () => {
    const { fetch, calls } = recordingFetch(() => json({}))
    const listing = await listProviderModels(
      {
        kind: 'bedrock',
        url: '',
        secret: '',
        options: { region: 'eu-north-1', models: { review: 'opus' } },
      },
      { fetch },
    )
    expect(calls).toHaveLength(0)
    expect(listing).toEqual({ models: [{ id: 'opus', source: 'config' }] })
  })
})

describe('latest', () => {
  const models = [
    { id: 'claude-opus-4-1' },
    { id: 'claude-opus-5-5' },
    { id: 'claude-opus-5-5-20261001' },
    { id: 'claude-opus-5-6-mini' },
    { id: 'claude-sonnet-5-5' },
    { id: 'gpt-5', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'gpt-5.1' },
  ]

  test('picks the highest numeric version of a prefix', () => {
    expect(resolveLatestModel('claude-opus@latest', models)).toBe('claude-opus-5-5-20261001')
    expect(resolveLatestModel('claude-opus-4@latest', models)).toBe('claude-opus-4-1')
    expect(resolveLatestModel('gpt@latest', models)).toBe('gpt-5.1')
    expect(resolveLatestModel('claude-opus-5-5', models)).toBe('claude-opus-5-5')
    expect(resolveLatestModel('gemini@latest', models)).toBeUndefined()
  })

  test('resolves routing and names what matches nothing', () => {
    expect(
      resolveLatestRouting(
        { model: 'claude-sonnet@latest', models: { review: 'claude-opus-4@latest' } },
        models,
      ),
    ).toEqual({ model: 'claude-sonnet-5-5', models: { review: 'claude-opus-4-1' } })
    expect(() => resolveLatestRouting({ model: 'gemini@latest' }, models)).toThrow(
      'no listed model matches gemini@latest',
    )
  })

  test('resolveProviderRouting lists only when a reference asks for latest', async () => {
    let listed = 0
    const list = async () => {
      listed++
      return { models: models.map((model) => ({ ...model, source: 'provider' as const })) }
    }
    const provider = { kind: 'anthropic', options: { models: { triage: 'claude-sonnet@latest' } } }
    expect(await resolveProviderRouting(provider, { model: 'claude-opus-5-5' }, list)).toEqual({
      model: 'claude-opus-5-5',
      models: { triage: 'claude-sonnet-5-5' },
    })
    expect(listed).toBe(1)
    expect(await resolveProviderRouting({ kind: 'anthropic' }, { model: 'x' }, list)).toEqual({
      model: 'x',
    })
    expect(listed).toBe(1)
    const failed = await resolveProviderRouting(
      { kind: 'anthropic' },
      { model: 'gemini@latest' },
      async () => ({ models: [], error: 'HTTP 500' }),
    ).catch((error: unknown) => error)
    expect(failed).toBeInstanceOf(Error)
    expect(String(failed)).toContain('no listed model matches gemini@latest (HTTP 500)')
  })

  test('resolveProviderRouting adds a fallback only for unrouted kinds the provider lists', async () => {
    const fallbacks = { 'library-digest': 'claude-haiku@latest' }
    expect(
      await resolveProviderRouting(
        { kind: 'anthropic' },
        { model: 'claude-opus-5-5' },
        listedIds(['claude-opus-5-5', 'claude-haiku-5-5']),
        fallbacks,
      ),
    ).toEqual({ model: 'claude-opus-5-5', models: { 'library-digest': 'claude-haiku-5-5' } })
    expect(
      await resolveProviderRouting(
        { kind: 'openai-compatible' },
        { model: 'gpt-5' },
        listedIds(['gpt-5']),
        fallbacks,
      ),
    ).toEqual({ model: 'gpt-5' })
    expect(
      await resolveProviderRouting(
        { kind: 'anthropic' },
        { model: 'claude-opus-5-5', models: { 'library-digest': 'claude-sonnet-5-5' } },
        listedIds(['claude-haiku-5-5']),
        fallbacks,
      ),
    ).toEqual({ model: 'claude-opus-5-5', models: { 'library-digest': 'claude-sonnet-5-5' } })
    expect(
      await resolveProviderRouting(
        { kind: 'anthropic', options: { models: { 'library-digest': 'claude-opus-5-5' } } },
        { model: 'claude-opus-5-5' },
        listedIds(['claude-haiku-5-5']),
        fallbacks,
      ),
    ).toEqual({ model: 'claude-opus-5-5' })
    expect(
      await resolveProviderRouting(
        { kind: 'anthropic' },
        { model: 'claude-opus-5-5' },
        async () => {
          throw new Error('catalog down')
        },
        fallbacks,
      ),
    ).toEqual({ model: 'claude-opus-5-5' })
  })

  test('modelCatalog caches listings per key and drops failed ones', async () => {
    let status = 200
    const { fetch, calls } = recordingFetch(() => json({ data: [{ id: 'gpt-5' }] }, status))
    let time = 0
    const catalog = modelCatalog({ fetch, ttlMs: 1000, now: () => time })
    const provider = { kind: 'openai-compatible', url: 'https://llm.test/v1', secret: 'k' }
    await catalog.list('a', provider)
    await catalog.list('a', provider)
    expect(calls).toHaveLength(1)
    time = 2000
    status = 500
    expect((await catalog.list('a', provider)).error).toContain('HTTP 500')
    status = 200
    await catalog.list('a', provider)
    expect(calls).toHaveLength(3)
  })
})

describe('ai-sdk models', () => {
  const catalog = {
    providers: async () => [
      {
        id: 'openrouter',
        name: 'OpenRouter',
        package: '@openrouter/ai-sdk-provider',
        env: [],
        models: [
          {
            id: 'openai/gpt-5',
            toolCall: true,
            reasoning: true,
            releaseDate: '2026-08-07',
            contextWindow: 400_000,
            pricing: { inputPerMTok: 1.25, outputPerMTok: 10 },
          },
          { id: 'old/model', toolCall: false, reasoning: false, releaseDate: 'someday' },
        ],
      },
    ],
  }

  test('come from the catalog, with configured prices winning', async () => {
    const listing = await listProviderModels(
      {
        kind: 'ai-sdk',
        url: 'https://openrouter.ai/api/v1',
        secret: 's',
        options: {
          provider: 'openrouter',
          package: '@openrouter/ai-sdk-provider',
          pricing: { 'openai/gpt-5': { inputPerMTok: 1, outputPerMTok: 2 } },
        },
      },
      { catalog },
    )
    expect(listing.models).toEqual([
      {
        id: 'openai/gpt-5',
        createdAt: '2026-08-07T00:00:00.000Z',
        pricing: { inputPerMTok: 1, outputPerMTok: 2 },
        toolCall: true,
        contextWindow: 400_000,
        source: 'catalog',
      },
      { id: 'old/model', toolCall: false, source: 'catalog' },
    ])
  })

  test('a provider of your own lists its OpenAI-compatible /models', async () => {
    const seen: string[] = []
    const listing = await listProviderModels(
      {
        kind: 'ai-sdk',
        url: 'https://llm.corp.test/v1',
        secret: 'k',
        options: { provider: 'corp' },
      },
      {
        catalog,
        fetch: (async (url: string, init?: RequestInit) => {
          seen.push(`${url} ${new Headers(init?.headers).get('authorization')}`)
          return Response.json({ data: [{ id: 'corp-large' }] })
        }) as unknown as typeof fetch,
      },
    )
    expect(seen).toEqual(['https://llm.corp.test/v1/models Bearer k'])
    expect(listing.models).toEqual([{ id: 'corp-large', source: 'provider' }])
  })
})
