import { describe, expect, test } from 'bun:test'

import { keyWords, normalizeKey, normalizeStepSchema } from './normalize.ts'

describe('normalizeKey', () => {
  test('splits any casing into words', () => {
    expect(keyWords('newHubV2')).toEqual(['new', 'Hub', 'V2'])
    expect(keyWords('NEW_HUB-v2')).toEqual(['NEW', 'HUB', 'v2'])
    expect(keyWords('HTTPServer')).toEqual(['HTTP', 'Server'])
  })

  test('applies steps in order', () => {
    expect(normalizeKey('  FEATURE_NEW_HUB ', ['trim-prefix:FEATURE_', 'snake'])).toBe('new_hub')
    expect(normalizeKey('newHub', ['snake'])).toBe('new_hub')
    expect(normalizeKey('new-hub', ['snake', 'upper'])).toBe('NEW_HUB')
    expect(normalizeKey('NEW_HUB', ['camel'])).toBe('newHub')
    expect(normalizeKey('newHub', ['kebab'])).toBe('new-hub')
    expect(normalizeKey('Hub', ['lower'])).toBe('hub')
    expect(normalizeKey('hub_enabled', ['trim-suffix:_ENABLED'])).toBe('hub')
    expect(normalizeKey('hub', ['trim-prefix:feature_'])).toBe('hub')
  })

  test('validates steps', () => {
    expect(normalizeStepSchema.safeParse('trim-prefix:X_').success).toBe(true)
    expect(normalizeStepSchema.safeParse('title').success).toBe(false)
    expect(normalizeStepSchema.safeParse('trim-prefix:').success).toBe(false)
  })
})
