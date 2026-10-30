import { describe, expect, test } from 'bun:test'

import type { StorageProviderView } from '@holtkeeper/api'

import { clearedMessage, shareOf, sortProviders } from './storage.ts'

const provider = (id: string, bytes: number, available = true): StorageProviderView => ({
  id,
  label: id,
  bytes,
  details: [],
  available,
  clearable: false,
})

describe('sortProviders', () => {
  test('puts available and larger areas first', () => {
    const sorted = sortProviders([
      provider('mise', 0, false),
      provider('db', 10),
      provider('artifacts', 500),
      provider('cache', 10),
    ])
    expect(sorted.map((p) => p.id)).toEqual(['artifacts', 'cache', 'db', 'mise'])
  })
})

describe('shareOf', () => {
  test('is a clamped percentage', () => {
    expect(shareOf(25, 100)).toBe(25)
    expect(shareOf(5, 0)).toBe(0)
    expect(shareOf(200, 100)).toBe(100)
  })
})

describe('clearedMessage', () => {
  test('describes what was removed', () => {
    expect(clearedMessage({ removed: 12, bytes: 2048 })).toBe('Removed 12 items · 2.0 kB')
    expect(clearedMessage({ removed: 1 })).toBe('Removed 1 item')
    expect(clearedMessage({})).toBe('Cleared')
    expect(clearedMessage(undefined)).toBe('Cleared')
  })
})
