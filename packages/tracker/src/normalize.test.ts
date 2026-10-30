import { describe, expect, test } from 'bun:test'

import { keyWords, normalizeKey, normalizeStepSchema } from './normalize.ts'

describe('normalizeKey', () => {
  test('splits any casing into words', () => {
    expect(keyWords('newLobbyV2')).toEqual(['new', 'Lobby', 'V2'])
    expect(keyWords('NEW_LOBBY-v2')).toEqual(['NEW', 'LOBBY', 'v2'])
    expect(keyWords('HTTPServer')).toEqual(['HTTP', 'Server'])
  })

  test('applies steps in order', () => {
    expect(normalizeKey('  FEATURE_NEW_LOBBY ', ['trim-prefix:FEATURE_', 'snake'])).toBe(
      'new_lobby',
    )
    expect(normalizeKey('newLobby', ['snake'])).toBe('new_lobby')
    expect(normalizeKey('new-lobby', ['snake', 'upper'])).toBe('NEW_LOBBY')
    expect(normalizeKey('NEW_LOBBY', ['camel'])).toBe('newLobby')
    expect(normalizeKey('newLobby', ['kebab'])).toBe('new-lobby')
    expect(normalizeKey('Lobby', ['lower'])).toBe('lobby')
    expect(normalizeKey('lobby_enabled', ['trim-suffix:_ENABLED'])).toBe('lobby')
    expect(normalizeKey('lobby', ['trim-prefix:feature_'])).toBe('lobby')
  })

  test('validates steps', () => {
    expect(normalizeStepSchema.safeParse('trim-prefix:X_').success).toBe(true)
    expect(normalizeStepSchema.safeParse('title').success).toBe(false)
    expect(normalizeStepSchema.safeParse('trim-prefix:').success).toBe(false)
  })
})
