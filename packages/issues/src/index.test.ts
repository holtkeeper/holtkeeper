import { describe, expect, test } from 'bun:test'

import { cachedTracker, issuesByKey } from './index.ts'
import { fakeIssueTracker } from './testing.ts'

const memoryCache = () => {
  const values = new Map<string, { value: unknown; ttl?: number }>()
  return {
    values,
    get: async (key: string) => values.get(key)?.value,
    set: async (key: string, value: unknown, ttl?: number) =>
      void values.set(key, { value, ...(ttl ? { ttl } : {}) }),
  }
}

const shape = { key: 'ABC-1', title: 'Round the corners', category: 'done' as const }
const widget = {
  key: 'ABC-2',
  title: 'Add a widget',
  status: 'In review',
  category: 'doing' as const,
}

describe('cachedTracker', () => {
  test('asks the tracker once per key and remembers missing keys', async () => {
    const tracker = fakeIssueTracker([shape, widget])
    const cache = memoryCache()
    const cached = cachedTracker(tracker, cache, { namespace: 'c1' })
    const first = await cached.issues(['ABC-1', 'ABC-2', 'ABC-9', 'ABC-1'])
    expect(first.map((issue) => issue.key).toSorted()).toEqual(['ABC-1', 'ABC-2'])
    expect(tracker.calls).toEqual([['ABC-1', 'ABC-2', 'ABC-9']])
    expect(cache.values.get('issues:fake:c1:ABC-1')?.ttl).toBe(86_400)
    expect(cache.values.get('issues:fake:c1:ABC-2')?.ttl).toBe(3600)
    expect(cache.values.get('issues:fake:c1:ABC-9')?.value).toEqual({ issue: null })

    const second = await cached.issues(['ABC-2', 'ABC-9'])
    expect(second).toEqual([widget])
    expect(tracker.calls).toHaveLength(1)
  })

  test('skips a cache that fails', async () => {
    const tracker = fakeIssueTracker([shape])
    const broken = {
      get: () => Promise.reject(new Error('down')),
      set: () => Promise.reject(new Error('down')),
    }
    expect(await cachedTracker(tracker, broken, { namespace: 'c1' }).issues(['ABC-1'])).toEqual([
      shape,
    ])
  })
})

describe('issuesByKey', () => {
  test('maps issues by key and is empty without a tracker or keys', async () => {
    expect(await issuesByKey(fakeIssueTracker([shape]), ['ABC-1'])).toEqual({ 'ABC-1': shape })
    expect(await issuesByKey(undefined, ['ABC-1'])).toEqual({})
    const tracker = fakeIssueTracker([shape])
    expect(await issuesByKey(tracker, [])).toEqual({})
    expect(tracker.calls).toEqual([])
  })

  test('falls back to no issues when the tracker fails', async () => {
    const errors: unknown[] = []
    const result = await issuesByKey(
      fakeIssueTracker([], { fail: new Error('401 Unauthorized') }),
      ['ABC-1'],
      (error) => errors.push(error),
    )
    expect(result).toEqual({})
    expect(errors).toHaveLength(1)
  })
})
