import { describe, expect, test } from 'bun:test'

import { cosine, encodeVector } from '@holtkeeper/embed'

import { createOpenAiEmbedder } from './embedder.ts'
import { EmbeddingError } from './http.ts'
import { listEmbeddingModels } from './models.ts'

const KEY = 'sk-test-secret-1234'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: { model: string; input: string[]; encoding_format: string; dimensions?: number } | undefined
}

type Reply = (call: Call) => Response | Promise<Response>

/** A `fetch` answering with `replies` in turn (the last one repeats), recording every request. */
function fakeFetch(...replies: Reply[]) {
  const calls: Call[] = []
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    init?.signal?.throwIfAborted()
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!
    return reply(call)
  }
  return { fetch: fn as unknown as typeof fetch, calls }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

/** An embeddings answer: text `i` gets a vector of `size` numbers pointing at axis `i % size`. */
const embeddings =
  (size: number, tokensPerText = 2): Reply =>
  (call) =>
    json({
      object: 'list',
      data: call
        .body!.input.map((_text, index) => ({
          object: 'embedding',
          index,
          embedding: Array.from({ length: size }, (_zero, axis) => (axis === index % size ? 3 : 0)),
        }))
        .toReversed(),
      usage: {
        prompt_tokens: call.body!.input.length * tokensPerText,
        total_tokens: call.body!.input.length * tokensPerText,
      },
    })

/** What `promise` rejects with; fails the test when it resolves. */
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (error: unknown) => error,
  )

const embedderFor = (model: string) =>
  createOpenAiEmbedder({ url: 'https://gateway.example/v1', apiKey: KEY, model })

const replying = (reply: Reply) =>
  createOpenAiEmbedder({
    url: 'https://gateway.example/v1',
    apiKey: KEY,
    model: 'acme/embed-small',
    fetch: fakeFetch(reply).fetch,
  })

describe('createOpenAiEmbedder', () => {
  test('posts the OpenAI format and returns normalized vectors in input order', async () => {
    const { fetch, calls } = fakeFetch(embeddings(4))
    const embedder = createOpenAiEmbedder({
      url: 'https://gateway.example/v1/',
      apiKey: KEY,
      model: 'acme/embed-small',
      fetch,
    })
    const result = await embedder.embed(['alpha', 'beta', ''], 'document')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      url: 'https://gateway.example/v1/embeddings',
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: { model: 'acme/embed-small', input: ['alpha', 'beta', ' '], encoding_format: 'float' },
    })
    expect(calls[0]!.body).not.toHaveProperty('dimensions')
    expect(result.tokens).toBe(6)
    expect(result.vectors.map((vector) => Array.from(vector))).toEqual([
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
    ])
    expect(embedder.dimensions).toBe(4)
    expect(embedder.id).toBe('openai:acme/embed-small@4')
  })

  test('splits texts into batches and sums tokens', async () => {
    const { fetch, calls } = fakeFetch(embeddings(8, 1))
    const embedder = createOpenAiEmbedder({
      url: 'https://gateway.example/v1',
      apiKey: KEY,
      model: 'acme/embed-small',
      batchSize: 2,
      fetch,
    })
    const result = await embedder.embed(['a', 'b', 'c', 'd', 'e'], 'document')
    expect(calls.map((call) => call.body!.input)).toEqual([['a', 'b'], ['c', 'd'], ['e']])
    expect(result.vectors).toHaveLength(5)
    expect(result.tokens).toBe(5)
    expect(cosine(result.vectors[0]!, result.vectors[2]!)).toBe(1)
    expect(await embedder.embed([], 'query')).toEqual({ vectors: [], tokens: 0 })
    expect(calls).toHaveLength(3)
  })

  test('sends dimensions when set and uses it in the id before any call', async () => {
    const { fetch, calls } = fakeFetch(embeddings(4))
    const embedder = createOpenAiEmbedder({
      url: 'https://gateway.example/v1',
      apiKey: KEY,
      model: 'acme/embed-small',
      dimensions: 4,
      provider: 'gateway',
      fetch,
    })
    expect(embedder.id).toBe('gateway:acme/embed-small@4')
    await embedder.embed(['a'], 'query')
    expect(calls[0]!.body!.dimensions).toBe(4)
  })

  test('knows the sizes of common models and asks for dimensions otherwise', () => {
    expect(embedderFor('openai/text-embedding-3-small').dimensions).toBe(1536)
    expect(embedderFor('text-embedding-3-large').id).toBe('openai:text-embedding-3-large@3072')
    expect(embedderFor('openai/text-embedding-ada-002').dimensions).toBe(1536)
    expect(() => embedderFor('acme/embed-small').dimensions).toThrow(/set `dimensions`/)
    expect(() => embedderFor('acme/embed-small').id).toThrow(/set `dimensions`/)
  })

  test('rejects vectors of an unexpected size', async () => {
    const { fetch } = fakeFetch(embeddings(4))
    const embedder = createOpenAiEmbedder({
      url: 'https://gateway.example/v1',
      apiKey: KEY,
      model: 'acme/embed-small',
      dimensions: 8,
      fetch,
    })
    const error = await embedder.embed(['a'], 'document').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(EmbeddingError)
    expect(error).toMatchObject({ code: 'dimension_mismatch' })
  })

  test('rejects an answer with fewer vectors than texts', async () => {
    const { fetch } = fakeFetch(() => json({ data: [{ index: 0, embedding: [1, 0] }] }))
    const embedder = createOpenAiEmbedder({
      url: 'https://gateway.example/v1',
      apiKey: KEY,
      model: 'acme/embed-small',
      fetch,
    })
    expect(await failure(embedder.embed(['a', 'b'], 'document'))).toMatchObject({
      code: 'invalid_response',
    })
  })

  test('decodes base64 vectors', async () => {
    const base64 = Buffer.from(encodeVector(Float32Array.of(0, 2))).toString('base64')
    const { fetch } = fakeFetch(() => json({ data: [{ index: 0, embedding: base64 }] }))
    const embedder = createOpenAiEmbedder({
      url: 'https://gateway.example/v1',
      apiKey: KEY,
      model: 'acme/embed-small',
      fetch,
    })
    const { vectors, tokens } = await embedder.embed(['a'], 'document')
    expect([...vectors[0]!]).toEqual([0, 1])
    expect(tokens).toBe(0)
  })

  test('prefixes texts by purpose', async () => {
    const { fetch, calls } = fakeFetch(embeddings(4))
    const embedder = createOpenAiEmbedder({
      url: 'https://gateway.example/v1',
      apiKey: KEY,
      model: 'acme/embed-small',
      queryPrefix: 'query: ',
      documentPrefix: 'passage: ',
      fetch,
    })
    await embedder.embed(['round corners'], 'query')
    await embedder.embed(['round corners'], 'document')
    expect(calls.map((call) => call.body!.input[0])).toEqual([
      'query: round corners',
      'passage: round corners',
    ])
  })

  test('retries 429 and 5xx honoring Retry-After, then succeeds', async () => {
    const { fetch, calls } = fakeFetch(
      () =>
        json({ error: { code: 'rate_limited', message: 'slow down' } }, 429, {
          'retry-after': '0',
        }),
      () => new Response('bad gateway', { status: 502, headers: { 'retry-after': '0' } }),
      embeddings(4),
    )
    const embedder = createOpenAiEmbedder({
      url: 'https://gateway.example/v1',
      apiKey: KEY,
      model: 'acme/embed-small',
      fetch,
    })
    expect((await embedder.embed(['a'], 'document')).vectors).toHaveLength(1)
    expect(calls).toHaveLength(3)
  })

  test('gives up after two retries with the API error', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({ error: { code: 'service_unavailable', message: 'The router is under load.' } }, 503, {
        'retry-after': '0',
      }),
    )
    const embedder = createOpenAiEmbedder({
      url: 'https://gateway.example/v1',
      apiKey: KEY,
      model: 'acme/embed-small',
      fetch,
    })
    const error = await embedder.embed(['a'], 'document').catch((e: unknown) => e)
    expect(calls).toHaveLength(3)
    expect(error).toBeInstanceOf(EmbeddingError)
    expect(error).toMatchObject({
      status: 503,
      code: 'service_unavailable',
      message: 'The router is under load.',
    })
  })

  test('does not retry other errors and never leaks the key', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json(
        { error: { code: 'invalid_api_key', message: `Incorrect API key provided: ${KEY}` } },
        401,
      ),
    )
    const embedder = createOpenAiEmbedder({
      url: 'https://gateway.example/v1',
      apiKey: KEY,
      model: 'acme/embed-small',
      fetch,
    })
    const error = (await embedder.embed(['a'], 'document').catch((e: unknown) => e)) as Error
    expect(calls).toHaveLength(1)
    expect(error).toMatchObject({ status: 401, code: 'invalid_api_key' })
    expect(error.message).toBe('Incorrect API key provided: ***')
    expect(JSON.stringify(error)).not.toContain(KEY)
    expect(String(error.stack)).not.toContain(KEY)
  })

  test('reads short and plain-text error bodies', async () => {
    expect(
      await failure(replying(() => json({ error: 'unauthorized' }, 401)).embed(['a'], 'query')),
    ).toMatchObject({ status: 401, message: 'unauthorized' })
    const html = replying(() => new Response('<html>Forbidden</html>', { status: 403 }))
    expect(await failure(html.embed(['a'], 'query'))).toMatchObject({
      status: 403,
      message: '<html>Forbidden</html>',
    })
  })

  test('stops waiting for a retry when aborted', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({ error: { message: 'busy' } }, 429, { 'retry-after': '30' }),
    )
    const embedder = createOpenAiEmbedder({
      url: 'https://gateway.example/v1',
      apiKey: KEY,
      model: 'acme/embed-small',
      fetch,
    })
    const controller = new AbortController()
    const pending = embedder.embed(['a'], 'document', controller.signal)
    setTimeout(() => controller.abort(new Error('stopped')), 10)
    expect(await failure(pending)).toMatchObject({ message: 'stopped' })
    expect(calls).toHaveLength(1)
  })
})

describe('listEmbeddingModels', () => {
  test('reads a Waibee-style catalog with classes and per-token prices', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({
        object: 'list',
        data: [
          {
            id: 'openai/text-embedding-3-small',
            model_class: 'embedding',
            pricing: { prompt: '0.00000002', completion: '0' },
          },
          { id: 'acme/embed-wide', model_class: 'embedding', dimensions: 1024 },
          { id: 'acme/chat-embedded', model_class: 'chat', pricing: { prompt: '0.000001' } },
        ],
      }),
    )
    const models = await listEmbeddingModels({
      url: 'https://gateway.example/v1/',
      apiKey: KEY,
      fetch,
    })
    expect(calls[0]).toMatchObject({
      url: 'https://gateway.example/v1/models?output_modalities=embeddings',
      method: 'GET',
      headers: { authorization: `Bearer ${KEY}` },
    })
    expect(models).toEqual([
      { id: 'acme/embed-wide', dimensions: 1024 },
      { id: 'openai/text-embedding-3-small', dimensions: 1536, pricePerMillionTokens: 0.02 },
    ])
  })

  test('keeps embedding ids when the endpoint ignores the filter', async () => {
    const { fetch } = fakeFetch(() =>
      json({
        data: [
          { id: 'gpt-5', object: 'model' },
          { id: 'text-embedding-3-large', object: 'model' },
          { id: 'text-embedding-ada-002', object: 'model' },
        ],
      }),
    )
    expect(
      await listEmbeddingModels({ url: 'https://gateway.example/v1', apiKey: KEY, fetch }),
    ).toEqual([
      { id: 'text-embedding-3-large', dimensions: 3072 },
      { id: 'text-embedding-ada-002', dimensions: 1536 },
    ])
  })

  test('throws EmbeddingError on a rejected key', async () => {
    const { fetch } = fakeFetch(() =>
      json({ error: { code: 'invalid_api_key', message: 'no' } }, 401),
    )
    expect(
      await failure(listEmbeddingModels({ url: 'https://gateway.example/v1', apiKey: KEY, fetch })),
    ).toBeInstanceOf(EmbeddingError)
  })
})
