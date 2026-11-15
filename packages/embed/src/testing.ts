import type { Embedder, EmbedPurpose } from './embedder.ts'
import { normalize } from './vectors.ts'

/** Options of `createFakeEmbedder`. */
export interface FakeEmbedderOptions {
  /** Default 256. */
  dimensions?: number
  /** Default `fake:hashed-words@<dimensions>`. */
  id?: string
}

/** A fake embedder that records every call. */
export type FakeEmbedder = Embedder & { calls: { texts: string[]; purpose: EmbedPurpose }[] }

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []

// FNV-1a: stable across runs and hosts, which a test fake needs more than spread.
function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * A deterministic, offline `Embedder` for tests: a text's vector is its hashed bag of lower-cased
 * words plus word bigrams (half weight), normalized. Texts sharing words get a high cosine,
 * unrelated texts one near 0; the same text always gets the same vector, whatever the purpose.
 * `tokens` is the number of words. Honors an aborted `signal`.
 */
export function createFakeEmbedder(options: FakeEmbedderOptions = {}): FakeEmbedder {
  const dimensions = options.dimensions ?? 256
  const calls: { texts: string[]; purpose: EmbedPurpose }[] = []
  const vectorOf = (text: string) => {
    const vector = new Float64Array(dimensions)
    const add = (feature: string, weight: number) => {
      const h = hash(feature)
      vector[h % dimensions]! += h & 0x80000000 ? -weight : weight
    }
    const list = words(text)
    list.forEach((word, i) => {
      add(word, 1)
      if (i > 0) add(`${list[i - 1]} ${word}`, 0.5)
    })
    return normalize(vector)
  }
  return {
    id: options.id ?? `fake:hashed-words@${dimensions}`,
    model: 'hashed-words',
    dimensions,
    calls,
    async embed(texts, purpose, signal) {
      signal?.throwIfAborted()
      calls.push({ texts: [...texts], purpose })
      return {
        vectors: texts.map(vectorOf),
        tokens: texts.reduce((sum, text) => sum + words(text).length, 0),
      }
    },
  }
}
