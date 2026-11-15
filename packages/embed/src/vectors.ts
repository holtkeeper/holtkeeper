/**
 * Cosine similarity of two vectors of the same length, from -1 to 1; 0 when either is all zeros.
 * Throws a `RangeError` when the lengths differ (vectors of different models never compare).
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length)
    throw new RangeError(`cannot compare vectors of ${a.length} and ${b.length} dimensions`)
  let dot = 0
  let left = 0
  let right = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    dot += x * y
    left += x * x
    right += y * y
  }
  if (!left || !right) return 0
  return dot / Math.sqrt(left * right)
}

/** `vector` scaled to unit length as a new `Float32Array`; an all-zero vector stays all zeros. */
export function normalize(vector: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(vector)
  let norm = 0
  for (const value of out) norm += value * value
  if (!norm) return out
  const scale = 1 / Math.sqrt(norm)
  for (let i = 0; i < out.length; i++) out[i] = out[i]! * scale
  return out
}

/** `vector` as bytes: four per number, little-endian float32, whatever the host's byte order. */
export function encodeVector(vector: Float32Array): Uint8Array {
  const bytes = new Uint8Array(vector.length * 4)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < vector.length; i++) view.setFloat32(i * 4, vector[i]!, true)
  return bytes
}

/**
 * The vector `encodeVector` wrote, from bytes that may be a view into a larger buffer (a driver's
 * `Buffer`). Throws a `RangeError` when the length is not a multiple of four.
 */
export function decodeVector(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 4)
    throw new RangeError(`vector bytes must be a multiple of 4, got ${bytes.byteLength}`)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Float32Array(bytes.byteLength / 4)
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true)
  return out
}

/** SHA-256 of `text` (UTF-8) as lowercase hex: tells whether an embedded text changed. */
export const contentHash = (text: string): string =>
  new Bun.CryptoHasher('sha256').update(text).digest('hex')

/**
 * Reciprocal rank fusion of several rankings of ids (best first): id → Σ 1/(k + rank), rank from 1.
 * An id missing from a ranking gets nothing from it; an id repeated within one ranking counts at its
 * first place. `k` (default 60) damps the weight of the top places.
 */
export function reciprocalRankFusion(
  rankings: readonly (readonly string[])[],
  k = 60,
): Map<string, number> {
  const fused = new Map<string, number>()
  for (const ranking of rankings) {
    const seen = new Set<string>()
    ranking.forEach((id, index) => {
      if (seen.has(id)) return
      seen.add(id)
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + index + 1))
    })
  }
  return fused
}
