import { expect, test } from 'bun:test'

import { inferConvention } from './infer.ts'

const screaming = Array.from({ length: 12 }, (_, i) => `LIMIT_${String.fromCodePoint(65 + i)}`)

test('outliers of an established convention', () => {
  const result = inferConvention([...screaming, 'maxSize', 'MAX', 'retry_count'])
  expect(result?.dominant).toBe('SCREAMING_SNAKE_CASE')
  expect(result?.total).toBe(15)
  expect(result?.outliers).toEqual([12, 14])
  expect(result?.established).toBe(true)
})

test('single words are compatible, not votes', () => {
  const result = inferConvention(['count', 'value', 'maxSize', 'total'])
  expect(result?.dominant).toBe('camelCase')
  expect(result?.share).toBe(1)
  expect(inferConvention(['count', 'value'])?.dominant).toBe('flatcase')
})

test('thresholds decide whether a convention is established', () => {
  expect(inferConvention(screaming.slice(0, 9))?.established).toBe(false)
  expect(inferConvention(screaming.slice(0, 9), { minNames: 5 })?.established).toBe(true)
  const split = [...screaming.slice(0, 8), 'a_b', 'c_d', 'e_f']
  expect(inferConvention(split)?.established).toBe(false)
  expect(inferConvention(split, { minShare: 0.7 })?.established).toBe(true)
  expect(inferConvention(['_', '$'])).toBeUndefined()
})
