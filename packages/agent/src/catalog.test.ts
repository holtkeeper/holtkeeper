import { describe, expect, test } from 'bun:test'

import { modelsDevCatalog, parseModelsDev } from './catalog.ts'

const document = {
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    npm: '@openrouter/ai-sdk-provider',
    env: ['OPENROUTER_API_KEY'],
    doc: 'https://openrouter.ai/models',
    models: {
      'anthropic/claude-opus-5-5': {
        id: 'anthropic/claude-opus-5-5',
        name: 'Claude Opus 5.5',
        tool_call: true,
        reasoning: true,
        release_date: '2026-09-01',
        limit: { context: 1_000_000, output: 64_000 },
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
      },
      'tiny/embed': { name: 'Embed', tool_call: false, cost: { input: 0.01 } },
    },
  },
  munito: {
    id: 'munito',
    name: 'Munito AI',
    npm: '@ai-sdk/openai-compatible',
    api: 'https://api.munito.test/v1',
    env: ['MUNITO_API_KEY'],
    models: {},
  },
  broken: { name: 'No package' },
  junk: 7,
}

describe('parseModelsDev', () => {
  test('reads providers, packages, models, limits and prices', () => {
    const [openrouter, munito, ...rest] = parseModelsDev(document)
    expect(rest).toEqual([])
    expect(openrouter).toMatchObject({
      id: 'openrouter',
      name: 'OpenRouter',
      package: '@openrouter/ai-sdk-provider',
      env: ['OPENROUTER_API_KEY'],
      doc: 'https://openrouter.ai/models',
    })
    expect(openrouter?.models).toEqual([
      {
        id: 'anthropic/claude-opus-5-5',
        name: 'Claude Opus 5.5',
        toolCall: true,
        reasoning: true,
        releaseDate: '2026-09-01',
        contextWindow: 1_000_000,
        outputLimit: 64_000,
        pricing: {
          inputPerMTok: 5,
          outputPerMTok: 25,
          cacheReadPerMTok: 0.5,
          cacheWritePerMTok: 6.25,
        },
      },
      { id: 'tiny/embed', name: 'Embed', toolCall: false, reasoning: false },
    ])
    expect(munito).toMatchObject({ api: 'https://api.munito.test/v1', models: [] })
    expect(parseModelsDev('nope')).toEqual([])
  })
})

describe('modelsDevCatalog', () => {
  test('caches for the ttl and keeps the last good copy when a refresh fails', async () => {
    let clock = 0
    let calls = 0
    let fail = false
    const catalog = modelsDevCatalog({
      url: 'https://catalog.test/api.json',
      ttlMs: 1000,
      now: () => clock,
      fetch: (async (url: string) => {
        calls++
        expect(url).toBe('https://catalog.test/api.json')
        return fail ? new Response('down', { status: 503 }) : Response.json(document)
      }) as unknown as typeof fetch,
    })
    expect((await catalog.providers()).map((p) => p.id)).toEqual(['openrouter', 'munito'])
    await catalog.providers()
    expect(calls).toBe(1)
    clock = 2000
    fail = true
    expect(await catalog.providers()).toHaveLength(2)
    expect(calls).toBe(2)
  })

  test('throws when the first load fails', async () => {
    const catalog = modelsDevCatalog({
      fetch: (async () => new Response('down', { status: 503 })) as unknown as typeof fetch,
    })
    expect(catalog.providers()).rejects.toThrow('HTTP 503')
  })
})
