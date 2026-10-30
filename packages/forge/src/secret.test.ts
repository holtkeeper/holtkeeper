import { afterEach, describe, expect, test } from 'bun:test'

import { env, resolveSecret } from './secret.ts'

describe('resolveSecret', () => {
  afterEach(() => {
    delete process.env.HOLTKEEPER_TEST_TOKEN
  })

  test('returns plain strings as is', () => {
    expect(resolveSecret('token')).toBe('token')
  })

  test('reads environment variables lazily', () => {
    const secret = env('HOLTKEEPER_TEST_TOKEN')
    process.env.HOLTKEEPER_TEST_TOKEN = 'from-env'
    expect(resolveSecret(secret)).toBe('from-env')
  })

  test('throws when the variable is missing', () => {
    expect(() => resolveSecret(env('HOLTKEEPER_TEST_TOKEN'))).toThrow(
      'environment variable HOLTKEEPER_TEST_TOKEN is not set',
    )
  })
})
