import { expect, test } from 'bun:test'

import { measure } from './measure.ts'

test('measures sizes without blocking the event loop', async () => {
  const words = Array.from({ length: 60_000 }, (_, index) => `word${(index * 7919) % 100_003}`)
  const content = new TextEncoder().encode(words.join(' '))
  let ticks = 0
  const timer = setInterval(() => ticks++, 1)
  const sizes = await measure(content)
  clearInterval(timer)
  expect(sizes.raw).toBe(content.byteLength)
  expect(sizes.gzip).toBeLessThan(sizes.raw)
  expect(sizes.brotli).toBeLessThan(sizes.raw)
  expect(ticks).toBeGreaterThan(0)
})
