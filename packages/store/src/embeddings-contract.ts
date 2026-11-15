import { expect, test } from 'bun:test'

import type { Store, StoredEmbedding } from './types.ts'

const vector = (...values: number[]) => Float32Array.from(values)

const plain = (rows: StoredEmbedding[]) =>
  rows.map(({ subject, model, hash, vector: v }) => ({ subject, model, hash, vector: [...v] }))

/** Contract tests every `EmbeddingStore` must pass. */
export function embeddingStoreTests(store: () => Store) {
  test('embeddings: put upserts by subject and model, list filters by model and prefix', async () => {
    const embeddings = store().embeddings
    const before = new Date().toISOString()
    await embeddings.put([
      { subject: 'knowledge:b', model: 'fake:m@3', hash: 'h1', vector: vector(0.5, -0.25, 1) },
      { subject: 'knowledge:a', model: 'fake:m@3', hash: 'h2', vector: vector(1, 0, 0) },
      { subject: 'knowledge:a', model: 'fake:other@2', hash: 'h3', vector: vector(0, 1) },
      { subject: 'library:x', model: 'fake:m@3', hash: 'h4', vector: vector(0, 0, 1) },
    ])
    await embeddings.put([
      { subject: 'knowledge:b', model: 'fake:m@3', hash: 'h5', vector: vector(0.125, 3.5, -2) },
    ])

    const all = await embeddings.list({ model: 'fake:m@3' })
    expect(plain(all)).toEqual([
      { subject: 'knowledge:a', model: 'fake:m@3', hash: 'h2', vector: [1, 0, 0] },
      { subject: 'knowledge:b', model: 'fake:m@3', hash: 'h5', vector: [0.125, 3.5, -2] },
      { subject: 'library:x', model: 'fake:m@3', hash: 'h4', vector: [0, 0, 1] },
    ])
    for (const row of all) {
      expect(row.vector).toBeInstanceOf(Float32Array)
      expect(Date.parse(row.updatedAt)).toBeGreaterThanOrEqual(Date.parse(before) - 1000)
      expect(new Date(row.updatedAt).toISOString()).toBe(row.updatedAt)
    }
    expect(
      (await embeddings.list({ model: 'fake:m@3', prefix: 'knowledge:' })).map((r) => r.subject),
    ).toEqual(['knowledge:a', 'knowledge:b'])
    expect(plain(await embeddings.list({ model: 'fake:other@2' }))).toEqual([
      { subject: 'knowledge:a', model: 'fake:other@2', hash: 'h3', vector: [0, 1] },
    ])
    expect(await embeddings.list({ model: 'missing' })).toEqual([])
    await embeddings.put([])
  })

  test('embeddings: keep float32 values exactly, also large vectors', async () => {
    const embeddings = store().embeddings
    const big = Float32Array.from({ length: 1536 }, (_, i) => Math.sin(i) / (i + 1))
    const tricky = vector(Math.PI, -0, 1e-30, 3.4e38, Number.MIN_VALUE)
    await embeddings.put([
      { subject: 'knowledge:big', model: 'fake:m@1536', hash: 'h', vector: big },
      { subject: 'knowledge:tricky', model: 'fake:m@5', hash: 'h', vector: tricky },
    ])
    const [stored] = await embeddings.list({ model: 'fake:m@1536' })
    expect(stored?.vector).toEqual(big)
    expect((await embeddings.list({ model: 'fake:m@5' }))[0]?.vector).toEqual(tricky)
  })

  test('embeddings: like prefixes match literally', async () => {
    const embeddings = store().embeddings
    await embeddings.put([
      { subject: 'kb_1:a', model: 'm', hash: 'h', vector: vector(1) },
      { subject: 'kbx1:b', model: 'm', hash: 'h', vector: vector(1) },
      { subject: 'kb%:c', model: 'm', hash: 'h', vector: vector(1) },
    ])
    expect((await embeddings.list({ model: 'm', prefix: 'kb_' })).map((r) => r.subject)).toEqual([
      'kb_1:a',
    ])
    expect((await embeddings.list({ model: 'm', prefix: 'kb%' })).map((r) => r.subject)).toEqual([
      'kb%:c',
    ])
  })

  test('embeddings: remove drops subjects for every model, pruneModels keeps one model', async () => {
    const embeddings = store().embeddings
    await embeddings.put([
      { subject: 'knowledge:a', model: 'm1', hash: 'h', vector: vector(1) },
      { subject: 'knowledge:a', model: 'm2', hash: 'h', vector: vector(1) },
      { subject: 'knowledge:b', model: 'm1', hash: 'h', vector: vector(1) },
      { subject: 'knowledge:c', model: 'm2', hash: 'h', vector: vector(1) },
      { subject: 'knowledge:d', model: 'm3', hash: 'h', vector: vector(1) },
    ])
    await embeddings.remove(['knowledge:a', 'knowledge:missing'])
    await embeddings.remove([])
    expect((await embeddings.list({ model: 'm1' })).map((r) => r.subject)).toEqual(['knowledge:b'])
    expect((await embeddings.list({ model: 'm2' })).map((r) => r.subject)).toEqual(['knowledge:c'])
    expect(await embeddings.pruneModels('m1')).toBe(2)
    expect(await embeddings.pruneModels('m1')).toBe(0)
    expect(await embeddings.list({ model: 'm2' })).toEqual([])
    expect(await embeddings.list({ model: 'm3' })).toEqual([])
    expect((await embeddings.list({ model: 'm1' })).map((r) => r.subject)).toEqual(['knowledge:b'])
  })
}
