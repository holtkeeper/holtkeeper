import { expect, test } from 'bun:test'

import { createFleetCache } from '../src/fleet-cache.ts'

const counter = () => {
  let calls = 0
  return {
    load: async () => ++calls,
    get calls() {
      return calls
    },
  }
}

const key = (analysisIds: string[], repos: string[] = ['work:acme/a'], endpoint = 'licenses') => ({
  endpoint,
  analysisIds,
  repos,
})

test('answers from the cache while the endpoint, records and visibility stay the same', async () => {
  const cache = createFleetCache()
  const source = counter()
  expect(await cache.read(key(['a1', 'a2']), source.load)).toBe(1)
  expect(await cache.read(key(['a2', 'a1', 'a1']), source.load)).toBe(1)
  expect(source.calls).toBe(1)
})

test('loads again when a newer record replaces one it read', async () => {
  const cache = createFleetCache()
  const source = counter()
  await cache.read(key(['a1', 'a2']), source.load)
  expect(await cache.read(key(['a1', 'a3']), source.load)).toBe(2)
  expect(await cache.read(key(['a1', 'a2']), source.load)).toBe(3)
})

test('keeps callers with different visible repositories apart', async () => {
  const cache = createFleetCache()
  const source = counter()
  const ids = ['a1']
  expect(await cache.read(key(ids, ['work:acme/a', 'work:acme/b']), source.load)).toBe(1)
  expect(await cache.read(key(ids, ['work:acme/a']), source.load)).toBe(2)
  expect(await cache.read(key(ids, ['work:acme/b', 'work:acme/a']), source.load)).toBe(1)
  expect(await cache.read(key(ids, ['work:acme/a']), source.load)).toBe(2)
})

test('keeps endpoints apart', async () => {
  const cache = createFleetCache()
  const source = counter()
  expect(await cache.read(key(['a1'], undefined, 'licenses'), source.load)).toBe(1)
  expect(await cache.read(key(['a1'], undefined, 'findings'), source.load)).toBe(2)
  expect(await cache.read(key(['a1'], undefined, 'licenses'), source.load)).toBe(1)
})

test('drops the least recently used entry beyond the bound', async () => {
  const cache = createFleetCache({ maxEntries: 2 })
  const source = counter()
  await cache.read(key(['a1'], undefined, 'one'), source.load)
  await cache.read(key(['a1'], undefined, 'two'), source.load)
  await cache.read(key(['a1'], undefined, 'one'), source.load)
  await cache.read(key(['a1'], undefined, 'three'), source.load)
  expect(await cache.read(key(['a1'], undefined, 'one'), source.load)).toBe(1)
  expect(await cache.read(key(['a1'], undefined, 'two'), source.load)).toBe(4)
})

test('shares one load between concurrent reads', async () => {
  const cache = createFleetCache()
  const source = counter()
  const [first, second] = await Promise.all([
    cache.read(key(['a1']), source.load),
    cache.read(key(['a1']), source.load),
  ])
  expect([first, second]).toEqual([1, 1])
  expect(source.calls).toBe(1)
})

test('forgets a failed load', async () => {
  const cache = createFleetCache()
  const failing = cache.read(key(['a1']), () => Promise.reject(new Error('store down')))
  expect(String(await failing.catch((error: unknown) => error))).toContain('store down')
  expect(await cache.read(key(['a1']), async () => 'ok')).toBe('ok')
})

test('forgets a load that throws before returning a promise', async () => {
  const cache = createFleetCache()
  const failing = cache.read(key(['a1']), () => {
    throw new Error('bad input')
  })
  expect(String(await failing.catch((error: unknown) => error))).toContain('bad input')
  expect(await cache.read(key(['a1']), async () => 'ok')).toBe('ok')
})
