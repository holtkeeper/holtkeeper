import { expect, test } from 'bun:test'

import { nextPreference, parsePreference, resolveTheme } from './theme.ts'

test('theme preference', () => {
  expect(resolveTheme('system', true)).toBe('dark')
  expect(resolveTheme('system', false)).toBe('light')
  expect(resolveTheme('light', true)).toBe('light')
  expect(nextPreference('dark')).toBe('light')
  expect(nextPreference('light')).toBe('system')
  expect(nextPreference('system')).toBe('dark')
  expect(parsePreference('system')).toBe('system')
  expect(parsePreference('light')).toBe('light')
  expect(parsePreference('weird')).toBe('dark')
  expect(parsePreference(null)).toBe('dark')
})
