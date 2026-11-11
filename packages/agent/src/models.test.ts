import { describe, expect, test } from 'bun:test'

import { listProviderModels, modelCatalog, resolveLatestModel } from './models.ts'

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

  test('reads OpenRouter-style prices from an OpenAI-compatible listing of your own', async () => {
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
      { kind: 'ai-sdk', url: 'https://llm.test/v1/', secret: 'key', options: { provider: 'corp' } },
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

  test('matches vendor-prefixed ids and dotted versions', () => {
    const routed = [
      { id: 'acme/widget-pro-4.6' },
      { id: 'acme/widget-pro-4-5-20260101' },
      { id: 'acme/widget-pro-4.6-lite' },
      { id: 'other/widget-pro-9' },
      { id: 'acme/widget-max-5-5' },
    ]
    expect(resolveLatestModel('widget-pro@latest', routed)).toBe('other/widget-pro-9')
    expect(resolveLatestModel('acme/widget-pro@latest', routed)).toBe('acme/widget-pro-4.6')
    expect(resolveLatestModel('widget-pro-4@latest', routed)).toBe('acme/widget-pro-4.6')
    expect(resolveLatestModel('widget-pro-4-6@latest', routed)).toBe('acme/widget-pro-4.6')
    expect(resolveLatestModel('widget-pro-4.5@latest', routed)).toBe('acme/widget-pro-4-5-20260101')
    expect(resolveLatestModel('acme/widget-max@latest', routed)).toBe('acme/widget-max-5-5')
    expect(resolveLatestModel('nobody/widget-max@latest', routed)).toBeUndefined()
  })

  test('prefers the id without a vendor when both list the same version', () => {
    const both = [{ id: 'acme/gadget-3-2' }, { id: 'gadget-3-2' }, { id: 'zeta/gadget-3-2' }]
    expect(resolveLatestModel('gadget@latest', both)).toBe('gadget-3-2')
    expect(resolveLatestModel('gadget@latest', both.toReversed())).toBe('gadget-3-2')
    const vendored = [{ id: 'zeta/gadget-3-2' }, { id: 'acme/gadget-3-2' }]
    expect(resolveLatestModel('gadget@latest', vendored)).toBe('acme/gadget-3-2')
    expect(resolveLatestModel('gadget@latest', vendored.toReversed())).toBe('acme/gadget-3-2')
  })

  test('modelCatalog caches listings per key and drops failed ones', async () => {
    let status = 200
    const { fetch, calls } = recordingFetch(() => json({ data: [{ id: 'gpt-5' }] }, status))
    let time = 0
    const catalog = modelCatalog({ fetch, ttlMs: 1000, now: () => time })
    const provider = {
      kind: 'ai-sdk',
      url: 'https://llm.test/v1',
      secret: 'k',
      options: { provider: 'corp' },
    }
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
