import { expect, test } from 'bun:test'

import { globToRegExp, literalPrefix, matchesAny } from './glob.ts'

test('globs', () => {
  expect(globToRegExp('games/*').test('games/slots')).toBe(true)
  expect(globToRegExp('games/*').test('games/a/b')).toBe(false)
  expect(globToRegExp('src/**/*.{ts,tsx}').test('src/a.tsx')).toBe(true)
  expect(globToRegExp('src/**/*.{ts,tsx}').test('src/a/b/c.ts')).toBe(true)
  expect(globToRegExp('src/**/*.{ts,tsx}').test('src/a.json')).toBe(false)
  expect(globToRegExp('charts/*/values-?.yaml').test('charts/x/values-a.yaml')).toBe(true)
  expect(matchesAny('legacy_x', ['legacy_*'])).toBe(true)
  expect(literalPrefix('charts/*/values.yaml')).toBe('charts')
  expect(literalPrefix('**/*.ts')).toBe('')
  expect(literalPrefix('src/flags.json')).toBe('src')
})
