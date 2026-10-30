import { expect, test } from 'bun:test'

import { nextPreference, parsePreference, resolveTheme } from './theme.ts'

test('theme preference', () => {
  expect(resolveTheme('system', true)).toBe('dark')
  expect(resolveTheme('system', false)).toBe('light')
  expect(resolveTheme('light', true)).toBe('light')
  expect(nextPreference('system')).toBe('light')
  expect(nextPreference('light')).toBe('dark')
  expect(nextPreference('dark')).toBe('system')
  expect(parsePreference('dark')).toBe('dark')
  expect(parsePreference('weird')).toBe('system')
  expect(parsePreference(null)).toBe('system')
})
