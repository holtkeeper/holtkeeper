import { expect, test } from 'bun:test'

import { secretFingerprint } from './fingerprint.ts'
import { matchesService, serviceName } from './scope.ts'

test('serviceName reduces URLs to hosts and keeps plain names', () => {
  expect(serviceName('https://API.Example.com:8443/v1')).toBe('api.example.com')
  expect(serviceName('api.example.com')).toBe('api.example.com')
  expect(serviceName(' Widgets-DB ')).toBe('widgets-db')
})

test('matchesService covers hosts, subdomains and names', () => {
  const patterns = ['example.com', '*.widgets.test', 'widgets-db']
  expect(matchesService('example.com', patterns)).toBe(true)
  expect(matchesService('https://api.example.com/x', patterns)).toBe(true)
  expect(matchesService('notexample.com', patterns)).toBe(false)
  expect(matchesService('widgets.test', patterns)).toBe(false)
  expect(matchesService('a.widgets.test', patterns)).toBe(true)
  expect(matchesService('WIDGETS-DB', patterns)).toBe(true)
  expect(matchesService('widgets-db-2', patterns)).toBe(false)
  expect(matchesService('anything', [])).toBe(false)
})

test('secretFingerprint is the first 16 hex characters of the SHA-256', async () => {
  // printf %s 'some-value' | shasum -a 256
  expect(await secretFingerprint('some-value')).toBe(
    new Bun.CryptoHasher('sha256').update('some-value').digest('hex').slice(0, 16),
  )
  expect(await secretFingerprint('some-value')).toMatch(/^[0-9a-f]{16}$/)
})
