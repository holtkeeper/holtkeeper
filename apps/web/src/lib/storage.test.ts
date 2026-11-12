import { describe, expect, test } from 'bun:test'

import type { StorageProviderView } from '@holtkeeper/api'

import {
  clearedMessage,
  shareLabel,
  shareOf,
  sortProviders,
  storageDelta,
  storageShade,
} from './storage.ts'

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
    expect(clearedMessage({ requested: 3 })).toBe('Asked 3 workers to clear their copies')
    expect(clearedMessage({ requested: 0 })).toBe('No worker reports this area right now')
  })
})

describe('storageDelta', () => {
  test('signs the change against a week ago', () => {
    expect(storageDelta(3072, 1024)).toEqual({ text: '+2.0 kB', trend: 'up' })
    expect(storageDelta(1024, 3072)).toEqual({ text: '−2.0 kB', trend: 'down' })
    expect(storageDelta(5, 5)).toEqual({ text: '0', trend: 'flat' })
    expect(storageDelta(5, undefined)).toBeUndefined()
  })
})

describe('shareLabel and storageShade', () => {
  test('round shares and mark slivers', () => {
    expect(shareLabel(60, 100)).toBe('60%')
    expect(shareLabel(1, 400)).toBe('<1%')
    expect(shareLabel(0, 100)).toBe('0%')
  })

  test('fade by index and stop at the last shade', () => {
    expect(storageShade(0)).toBe('color-mix(in oklab, var(--fg) 86%, transparent)')
    expect(storageShade(20)).toBe('color-mix(in oklab, var(--fg) 9%, transparent)')
  })
})
