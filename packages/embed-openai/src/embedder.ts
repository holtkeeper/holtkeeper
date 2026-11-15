import type { Embedder, EmbedPurpose, EmbedResult } from '@holtkeeper/embed'
import { decodeVector, normalize } from '@holtkeeper/embed'

import { EmbeddingError, isRecord, requestJson } from './http.ts'
import { knownDimensions } from './models.ts'

/** How to reach an OpenAI Embeddings endpoint (OpenAI, Waibee Router, most gateways). */
export interface OpenAiEmbedderOptions {
  /** Base URL, e.g. `https://api.waibee.com/v1` (no trailing `/embeddings`). */
  url: string
  apiKey: string
  /** Model id as the endpoint names it, e.g. `openai/text-embedding-3-small` on Waibee. */
  model: string
  /** Sent only when set; otherwise learned from the first response. */
  dimensions?: number
  /** Id prefix. Default `openai`. */
  provider?: string
  /** Inputs per request. Default 128, at most 2048. */
  batchSize?: number
  /** Prepended to every `query` text, for models trained with asymmetric prefixes. */
  queryPrefix?: string
  /** Prepended to every `document` text. */
  documentPrefix?: string
  /** For tests. Default: the global `fetch`. */
  fetch?: typeof fetch
}

const MAX_BATCH = 2048

const vectorOf = (value: unknown): Float32Array | undefined => {
  if (typeof value === 'string') return decodeVector(Buffer.from(value, 'base64'))
  if (Array.isArray(value) && value.every((n) => typeof n === 'number'))
    return Float32Array.from(value)
  return undefined
}

/**
 * An `Embedder` over `POST {url}/embeddings` in the OpenAI format (`encoding_format: 'float'`).
 * Texts go in batches of `batchSize`, one request after another; vectors come back normalized, in
 * input order, and `tokens` sums the reported usage. `dimensions` (and so `id`,
 * `<provider>:<model>@<dimensions>`) is `options.dimensions`, else the length the first response
 * had, else the known size of the model (`text-embedding-3-small` 1536, `text-embedding-3-large`
 * 3072, `text-embedding-ada-002` 1536, with or without a vendor prefix); reading it for an unknown
 * model before the first call throws an error asking for `dimensions`. Vectors of another length
 * than the expected one throw an `EmbeddingError` (`dimension_mismatch`). API errors throw
 * `EmbeddingError`; 429 and 5xx are retried twice honoring `Retry-After`. Empty texts are sent as
 * a single space, which the endpoints accept.
 */
export function createOpenAiEmbedder(options: OpenAiEmbedderOptions): Embedder {
  const provider = options.provider ?? 'openai'
  const batchSize = Math.min(Math.max(1, Math.floor(options.batchSize ?? 128)), MAX_BATCH)
  let learned: number | undefined

  const dimensions = (): number => {
    const known = options.dimensions ?? learned ?? knownDimensions(options.model)
    if (known === undefined)
      throw new Error(
        `the vector size of embedding model ${options.model} is unknown: set \`dimensions\``,
      )
    return known
  }

  const prefix = (purpose: EmbedPurpose) =>
    (purpose === 'query' ? options.queryPrefix : options.documentPrefix) ?? ''

  async function batch(
    texts: readonly string[],
    purpose: EmbedPurpose,
    signal: AbortSignal | undefined,
  ): Promise<EmbedResult> {
    const body = await requestJson(options, '/embeddings', {
      method: 'POST',
      body: {
        model: options.model,
        input: texts.map((text) => `${prefix(purpose)}${text}` || ' '),
        encoding_format: 'float',
        ...(options.dimensions !== undefined && { dimensions: options.dimensions }),
      },
      signal,
    })
    const data: unknown[] = isRecord(body) && Array.isArray(body.data) ? body.data : []
    const byIndex = new Map<number, Float32Array>()
    data.forEach((item, position) => {
      if (!isRecord(item)) return
      const vector = vectorOf(item.embedding)
      if (vector) byIndex.set(typeof item.index === 'number' ? item.index : position, vector)
    })
    const expected = options.dimensions ?? learned ?? byIndex.get(0)?.length
    const vectors: Float32Array[] = []
    for (let index = 0; index < texts.length; index++) {
      const vector = byIndex.get(index)
      if (!vector)
        throw new EmbeddingError(
          200,
          `expected ${texts.length} embeddings, got ${byIndex.size}`,
          'invalid_response',
        )
      if (expected !== undefined && vector.length !== expected)
        throw new EmbeddingError(
          200,
          `expected vectors of ${expected} dimensions, got ${vector.length}`,
          'dimension_mismatch',
        )
      vectors.push(normalize(vector))
    }
    learned ??= vectors[0]?.length
    const usage = isRecord(body) && isRecord(body.usage) ? body.usage : {}
    const tokens =
      typeof usage.total_tokens === 'number'
        ? usage.total_tokens
        : typeof usage.prompt_tokens === 'number'
          ? usage.prompt_tokens
          : 0
    return { vectors, tokens }
  }

  return {
    get id() {
      return `${provider}:${options.model}@${dimensions()}`
    },
    model: options.model,
    get dimensions() {
      return dimensions()
    },
    async embed(texts, purpose, signal) {
      const result: EmbedResult = { vectors: [], tokens: 0 }
      for (let start = 0; start < texts.length; start += batchSize) {
        // oxlint-disable-next-line no-await-in-loop -- one request at a time keeps within rate limits
        const part = await batch(texts.slice(start, start + batchSize), purpose, signal)
        result.vectors.push(...part.vectors)
        result.tokens += part.tokens
      }
      return result
    },
  }
}
