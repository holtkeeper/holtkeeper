import { describe, expect, test } from 'bun:test'

import type { EgressCacheEntry } from '@holtkeeper/api'

import {
  cacheTotals,
  entryHost,
  entryName,
  filterEntries,
  formatTtl,
  hitRate,
  hostTotals,
} from './caches.ts'

const entry = (url: string, size: number, hits: number, kind: 'packages' | 'tools' = 'packages') =>
  ({
    path: url,
    url,
    kind,
    size,
    hits,
    storedAt: '2026-10-01T00:00:00Z',
    lastUsedAt: '2026-10-30T00:00:00Z',
    expiresAt: '2026-11-27T00:00:00Z',
    expired: false,
  }) satisfies EgressCacheEntry

const react = entry('https://registry.npmjs.org/react/-/react-19.1.0.tgz', 100, 3)
const scoped = entry('https://registry.npmjs.org/@types/node/-/node-24.0.0.tgz', 50, 0)
const node = entry(
  'https://nodejs.org/dist/v24.1.0/node-v24.1.0-linux-x64.tar.xz',
  1000,
  1,
  'tools',
)

describe('cacheTotals', () => {
  test('adds sizes and hits and counts every hit as one saved download', () => {
    expect(cacheTotals([react, scoped, node])).toEqual({
      count: 3,
      bytes: 1150,
      hits: 4,
      savedBytes: 1300,
    })
    expect(cacheTotals([])).toEqual({ count: 0, bytes: 0, hits: 0, savedBytes: 0 })
  })
})

describe('entries', () => {
  test('names the host and the file', () => {
    expect(entryHost(entry('https://localhost:8443/a/b.tgz', 1, 0))).toBe('localhost:8443')
    expect(entryName(scoped)).toBe('node-24.0.0.tgz')
    expect(entryName(entry('not a url', 1, 0))).toBe('not a url')
  })

  test('groups by host, largest first', () => {
    expect(hostTotals([react, scoped, node]).map((h) => [h.host, h.bytes])).toEqual([
      ['nodejs.org', 1000],
      ['registry.npmjs.org', 150],
    ])
  })

  test('filters by kind and every word of the query', () => {
    expect(filterEntries([react, scoped, node], 'tools', '')).toEqual([node])
    expect(filterEntries([react, scoped, node], 'all', 'NPMJS react')).toEqual([react])
  })
})

describe('hitRate', () => {
  test('is a percentage, undefined before any request', () => {
    expect(hitRate({ hits: 3, misses: 1 })).toBe(75)
    expect(hitRate({ hits: 0, misses: 0 })).toBeUndefined()
  })
})

describe('formatTtl', () => {
  test('uses the largest unit that divides the duration', () => {
    expect(formatTtl(28 * 86_400)).toBe('4 weeks')
    expect(formatTtl(10 * 86_400)).toBe('10 days')
    expect(formatTtl(3_600)).toBe('1 hour')
    expect(formatTtl(90)).toBe('90 seconds')
  })
})
