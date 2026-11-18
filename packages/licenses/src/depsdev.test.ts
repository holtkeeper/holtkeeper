import { expect, test } from 'bun:test'

import {
  type CachedLicenses,
  type DepsDevClient,
  type LicenseCache,
  depsDevClient,
  kvLicenseCache,
  lookupLicenses,
} from './depsdev.ts'

test('asks deps.dev v3 for one version, Go with the v prefix; 404 is no license', async () => {
  const urls: string[] = []
  const client = depsDevClient({
    baseUrl: 'https://deps.example.com/',
    fetch: (async (input: string) => {
      const url = input
      urls.push(url)
      if (url.includes('missing')) return new Response('not found', { status: 404 })
      if (url.includes('broken')) return new Response('oops', { status: 503 })
      return Response.json({ licenses: ['MIT', ' '] })
    }) as typeof fetch,
  })
  expect(await client.licenses({ ecosystem: 'npm', name: '@acme/ui', version: '1.2.3' })).toEqual([
    'MIT',
  ])
  expect(
    await client.licenses({ ecosystem: 'Go', name: 'example.com/kit', version: '0.4.0' }),
  ).toEqual(['MIT'])
  expect(await client.licenses({ ecosystem: 'npm', name: 'missing', version: '1.0.0' })).toEqual([])
  expect(await client.licenses({ ecosystem: 'PyPI', name: 'widget', version: '1.0.0' })).toEqual([])
  const failure: unknown = await client
    .licenses({ ecosystem: 'npm', name: 'broken', version: '1.0.0' })
    .catch((caught: unknown) => caught)
  expect(String(failure)).toContain('503')
  expect(urls.slice(0, 2)).toEqual([
    'https://deps.example.com/v3/systems/npm/packages/%40acme%2Fui/versions/1.2.3',
    'https://deps.example.com/v3/systems/go/packages/example.com%2Fkit/versions/v0.4.0',
  ])
})

const memoryCache = (initial: Record<string, CachedLicenses> = {}) => {
  let entries = new Map(Object.entries(initial))
  let writes = 0
  const cache: LicenseCache = {
    read: async () => new Map(entries),
    write: async (next) => {
      writes += 1
      entries = new Map(next)
    },
  }
  return { cache, entries: () => entries, writes: () => writes }
}

const now = new Date('2026-11-18T12:00:00Z')
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString()

test('looks up each distinct version once and reuses fresh cached answers', async () => {
  const asked: string[] = []
  const client: DepsDevClient = {
    licenses: async (pkg) => {
      asked.push(`${pkg.name}@${pkg.version}`)
      return pkg.name === 'widget' ? ['MIT'] : []
    },
  }
  const store = memoryCache({
    'npm:cached@1.0.0': { licenses: ['ISC'], checkedAt: daysAgo(10) },
    'npm:old@1.0.0': { licenses: ['ISC'], checkedAt: daysAgo(40) },
    'npm:none@1.0.0': { licenses: [], checkedAt: daysAgo(2) },
    'npm:unused@1.0.0': { licenses: ['MIT'], checkedAt: daysAgo(31) },
  })
  const result = await lookupLicenses({
    client,
    cache: store.cache,
    now,
    packages: [
      { ecosystem: 'npm', name: 'widget', version: '2.0.0' },
      { ecosystem: 'npm', name: 'widget', version: '2.0.0' },
      { ecosystem: 'npm', name: 'cached', version: '1.0.0' },
      { ecosystem: 'npm', name: 'old', version: '1.0.0' },
      { ecosystem: 'npm', name: 'none', version: '1.0.0' },
      { ecosystem: 'PyPI', name: 'skipped', version: '1.0.0' },
    ],
  })
  expect(asked.toSorted()).toEqual(['none@1.0.0', 'old@1.0.0', 'widget@2.0.0'])
  expect(Object.fromEntries(result.licenses)).toEqual({
    'npm:widget@2.0.0': ['MIT'],
    'npm:cached@1.0.0': ['ISC'],
    'npm:old@1.0.0': [],
    'npm:none@1.0.0': [],
  })
  expect(result).toMatchObject({ queried: 4, fetched: 3 })
  expect([...store.entries().keys()].toSorted()).toEqual([
    'npm:cached@1.0.0',
    'npm:none@1.0.0',
    'npm:old@1.0.0',
    'npm:widget@2.0.0',
  ])
})

test('a failed lookup throws and leaves the cache alone', async () => {
  const store = memoryCache()
  const client: DepsDevClient = {
    licenses: async (pkg) => {
      if (pkg.name === 'bad') throw new Error('unreachable')
      return ['MIT']
    },
  }
  const failure: unknown = await lookupLicenses({
    client,
    cache: store.cache,
    now,
    packages: [
      { ecosystem: 'npm', name: 'good', version: '1.0.0' },
      { ecosystem: 'npm', name: 'bad', version: '1.0.0' },
    ],
  }).catch((caught: unknown) => caught)
  expect(String(failure)).toContain('unreachable')
  expect(store.writes()).toBe(0)
})

test('the key-value cache keeps every entry under one key', async () => {
  const values = new Map<string, unknown>()
  const kv = {
    get: async (key: string) => values.get(key),
    set: async (key: string, value: unknown) => {
      values.set(key, value)
    },
  }
  const cache = kvLicenseCache(kv)
  expect((await cache.read()).size).toBe(0)
  await cache.write(new Map([['npm:a@1.0.0', { licenses: ['MIT'], checkedAt: daysAgo(0) }]]))
  expect([...values.keys()]).toEqual(['license-index:licenses'])
  expect(await cache.read()).toEqual(
    new Map([['npm:a@1.0.0', { licenses: ['MIT'], checkedAt: daysAgo(0) }]]),
  )
})
