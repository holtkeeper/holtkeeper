import { describe, expect, test } from 'bun:test'

import {
  contentHash,
  cosine,
  decodeVector,
  encodeVector,
  normalize,
  reciprocalRankFusion,
} from './vectors.ts'

describe('cosine', () => {
  test('is 1 for the same direction, 0 for orthogonal, -1 for opposite', () => {
    const a = Float32Array.of(1, 2, 3)
    expect(cosine(a, Float32Array.of(2, 4, 6))).toBeCloseTo(1, 6)
    expect(cosine(Float32Array.of(1, 0), Float32Array.of(0, 1))).toBe(0)
    expect(cosine(a, Float32Array.of(-1, -2, -3))).toBeCloseTo(-1, 6)
  })

  test('is 0 for a zero vector and throws on different lengths', () => {
    expect(cosine(Float32Array.of(0, 0), Float32Array.of(1, 1))).toBe(0)
    expect(() => cosine(Float32Array.of(1), Float32Array.of(1, 2))).toThrow(RangeError)
  })
})

describe('normalize', () => {
  test('scales to unit length without changing the input', () => {
    const input = [3, 4]
    const unit = normalize(input)
    expect([...unit]).toEqual([0.6000000238418579, 0.800000011920929])
    expect(input).toEqual([3, 4])
    expect(cosine(unit, unit)).toBeCloseTo(1, 6)
  })

  test('keeps a zero vector', () => {
    expect([...normalize([0, 0, 0])]).toEqual([0, 0, 0])
  })
})

describe('vector bytes', () => {
  test('round-trip a vector', () => {
    const vector = Float32Array.of(0.25, -1.5, 3.125, 0, Number.MIN_VALUE)
    expect(decodeVector(encodeVector(vector))).toEqual(vector)
  })

  test('are little-endian float32', () => {
    // 1.0 is 0x3f800000: little-endian puts the low byte first.
    expect([...encodeVector(Float32Array.of(1))]).toEqual([0x00, 0x00, 0x80, 0x3f])
    expect(decodeVector(Uint8Array.of(0x00, 0x00, 0x80, 0xbf))).toEqual(Float32Array.of(-1))
  })

  test('decode a view at an offset into a larger buffer', () => {
    const bytes = encodeVector(Float32Array.of(2, 4))
    const buffer = new Uint8Array(bytes.length + 3)
    buffer.set(bytes, 3)
    expect(decodeVector(buffer.subarray(3))).toEqual(Float32Array.of(2, 4))
    expect(decodeVector(Buffer.from(bytes))).toEqual(Float32Array.of(2, 4))
  })

  test('reject a length that is not a multiple of four', () => {
    expect(() => decodeVector(new Uint8Array(5))).toThrow(RangeError)
  })
})

describe('contentHash', () => {
  test('is a stable SHA-256 hex of the exact text', () => {
    expect(contentHash('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(contentHash('Round the widget corners')).toBe(contentHash('Round the widget corners'))
    expect(contentHash('Round the widget corners')).not.toBe(
      contentHash('round the widget corners'),
    )
    expect(contentHash('ü')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('reciprocalRankFusion', () => {
  test('sums 1/(k + rank) over the rankings', () => {
    const fused = reciprocalRankFusion([
      ['a', 'b', 'c'],
      ['c', 'a'],
    ])
    expect(fused.get('a')).toBeCloseTo(1 / 61 + 1 / 62, 12)
    expect(fused.get('b')).toBeCloseTo(1 / 62, 12)
    expect(fused.get('c')).toBeCloseTo(1 / 63 + 1 / 61, 12)
    expect(fused.has('d')).toBe(false)
  })

  test('takes k and counts a repeated id at its first place', () => {
    const fused = reciprocalRankFusion([['a', 'a', 'b']], 1)
    expect(fused.get('a')).toBe(1 / 2)
    expect(fused.get('b')).toBe(1 / 4)
  })

  test('agreeing rankings beat a single first place', () => {
    const fused = reciprocalRankFusion([
      ['x', 'y'],
      ['z', 'y'],
    ])
    expect(fused.get('y')!).toBeGreaterThan(fused.get('x')!)
    expect(reciprocalRankFusion([]).size).toBe(0)
  })
})
