import { describe, expect, test } from 'bun:test'

import { createFakeEmbedder } from './testing.ts'
import { cosine } from './vectors.ts'

describe('createFakeEmbedder', () => {
  test('is deterministic, unit length and records calls', async () => {
    const embedder = createFakeEmbedder()
    expect(embedder.id).toBe('fake:hashed-words@256')
    expect(embedder.dimensions).toBe(256)
    const first = await embedder.embed(['Round the widget corners', 'Shapes'], 'document')
    const again = await createFakeEmbedder().embed(['Round the widget corners'], 'query')
    expect(first.vectors).toHaveLength(2)
    expect(first.vectors[0]).toEqual(again.vectors[0])
    expect(first.vectors[0]!.length).toBe(256)
    expect(cosine(first.vectors[0]!, first.vectors[0]!)).toBeCloseTo(1, 5)
    expect(first.tokens).toBe(5)
    expect(embedder.calls).toEqual([
      { texts: ['Round the widget corners', 'Shapes'], purpose: 'document' },
    ])
  })

  test('similar texts score higher than unrelated ones', async () => {
    const embedder = createFakeEmbedder()
    const {
      vectors: [query, similar, unrelated],
    } = await embedder.embed(
      [
        'widget corners should be rounded',
        'Rounded corners on every widget: use the radius token',
        'Release notes list merged tickets by component',
      ],
      'document',
    )
    expect(cosine(query!, similar!)).toBeGreaterThan(0.3)
    expect(cosine(query!, similar!)).toBeGreaterThan(cosine(query!, unrelated!) + 0.2)
  })

  test('takes dimensions and an id, and honors an aborted signal', async () => {
    const embedder = createFakeEmbedder({ dimensions: 8, id: 'fake:tiny@8' })
    expect(embedder.id).toBe('fake:tiny@8')
    expect((await embedder.embed(['a b c'], 'query')).vectors[0]!.length).toBe(8)
    const controller = new AbortController()
    controller.abort()
    const aborted = await embedder.embed(['a'], 'query', controller.signal).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(aborted).toBeInstanceOf(Error)
  })
})
