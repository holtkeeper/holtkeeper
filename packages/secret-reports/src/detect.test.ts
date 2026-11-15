import { expect, test } from 'bun:test'

import { looksLikeSecret, maskProblem } from './detect.ts'

test('recognizes well-known credential shapes', () => {
  for (const text of [
    'key AKIAABCDEFGHIJKLMNOP leaked',
    'ghp_abcdefghijklmnopqrstuvwxyz0123',
    'glpat-abcdefghij0123456789',
    'xoxb-1234567890-abcdefghij',
    'sk-proj-abcdefghijklmnop1234',
    'rk_live_abcdefghij1234',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl',
    'postgres://widget:hunter2@db.example.com/widgets',
    'https://hooks.slack.com/services/T000/B000/XXXX',
  ])
    expect(looksLikeSecret(text)).toBe(true)
})

test('recognizes long random runs and long hex', () => {
  expect(looksLikeSecret('the value was Zx8qL2mP9vR4tY7wK3nB6cJ1')).toBe(true)
  expect(looksLikeSecret('0123456789abcdef0123456789abcdef')).toBe(true)
})

test('lets names, hosts and prose through', () => {
  for (const text of [
    'WIDGET_SERVICE_API_KEY_PRODUCTION',
    'widgets.database.primary.password',
    'api.widgets.example.com',
    'gitlab:shapes/widget-factory',
    'A .env file was printed while debugging the test setup of the widget importer.',
    'unknown',
  ])
    expect(looksLikeSecret(text)).toBe(false)
})

test('masks show at most a quarter of the value and nothing of passwords', () => {
  expect(maskProblem('wk_l…(40)', 'api-key')).toBeUndefined()
  expect(maskProblem('…(12)', 'password')).toBeUndefined()
  expect(maskProblem('ab…(12)', 'password')).toContain('passwords')
  expect(maskProblem('abcd…(8)', 'token')).toContain('at most 2')
  expect(maskProblem('wk_live_123', 'api-key')).toContain('expected')
  expect(maskProblem('abcde…(40)', 'api-key')).toContain('expected')
})
