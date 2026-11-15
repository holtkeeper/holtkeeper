import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_EMBEDDING_MODEL,
  embeddingModelOptions,
  embeddingsDraft,
  embeddingsStatusLine,
  formatEmbeddingPrice,
  parseEmbeddingsDraft,
  sameEmbeddingsDraft,
} from './embeddings.ts'

describe('embeddingsDraft', () => {
  test('takes the defaults for a missing or malformed value', () => {
    expect(embeddingsDraft(undefined)).toEqual({
      enabled: false,
      credential: '',
      model: DEFAULT_EMBEDDING_MODEL,
      dimensions: '',
    })
    expect(embeddingsDraft({ enabled: 'yes', model: 3, dimensions: 'many' })).toMatchObject({
      enabled: false,
      model: DEFAULT_EMBEDDING_MODEL,
      dimensions: '',
    })
  })

  test('round-trips a stored value', () => {
    const value = { enabled: true, credential: 'gateway', model: 'acme/embed', dimensions: 512 }
    expect(parseEmbeddingsDraft(embeddingsDraft(value))).toEqual({ value })
  })
})

describe('parseEmbeddingsDraft', () => {
  const draft = { enabled: true, credential: ' ', model: ' acme/embed ', dimensions: '' }

  test('leaves out an empty credential and dimensions', () => {
    expect(parseEmbeddingsDraft(draft)).toEqual({ value: { enabled: true, model: 'acme/embed' } })
  })

  test('refuses an empty model and bad dimensions', () => {
    expect(parseEmbeddingsDraft({ ...draft, model: '' })).toHaveProperty('error')
    for (const dimensions of ['0', '1.5', 'abc', '9000'])
      expect(parseEmbeddingsDraft({ ...draft, dimensions })).toHaveProperty('error')
    expect(parseEmbeddingsDraft({ ...draft, dimensions: '256' })).toEqual({
      value: { enabled: true, model: 'acme/embed', dimensions: 256 },
    })
  })

  test('drafts that save the same value are the same', () => {
    expect(sameEmbeddingsDraft(draft, { ...draft, model: 'acme/embed' })).toBe(true)
    expect(sameEmbeddingsDraft(draft, { ...draft, enabled: false })).toBe(false)
  })
})

describe('models', () => {
  test('formats prices per million tokens', () => {
    expect(formatEmbeddingPrice(0.02)).toBe('$0.02 / 1M tokens')
    expect(formatEmbeddingPrice(0.13)).toBe('$0.13 / 1M tokens')
    expect(formatEmbeddingPrice(undefined)).toBeUndefined()
  })

  test('lists models by id and keeps an unlisted current model first', () => {
    const models = [
      { id: 'b/small', dimensions: 256 },
      { id: 'a/large', dimensions: 1024, pricePerMillionTokens: 0.1 },
    ]
    expect(embeddingModelOptions(models, 'b/small')).toEqual([
      { id: 'a/large', detail: '1024 dimensions · $0.1 / 1M tokens' },
      { id: 'b/small', detail: '256 dimensions' },
    ])
    expect(embeddingModelOptions(models, 'c/typo')[0]).toEqual({ id: 'c/typo', unlisted: true })
  })
})

describe('embeddingsStatusLine', () => {
  test('off says search is full text', () => {
    expect(embeddingsStatusLine({ state: 'off', indexed: 0, total: 0 })).toMatchObject({
      label: 'Off',
      facts: ['Search and Guide notes use full text only'],
    })
  })

  test('names progress, model and the error', () => {
    const line = embeddingsStatusLine({
      state: 'error',
      model: 'acme/embed',
      indexed: 3,
      total: 4,
      error: 'the endpoint is down',
    })
    expect(line).toMatchObject({ label: 'Error', tone: 'danger' })
    expect(line.facts).toEqual(['3 of 4 notes indexed', 'acme/embed'])
    expect(line.error).toContain('full text')
  })
})
