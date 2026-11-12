import { expect, test } from 'bun:test'

import { httpUrl } from './url.ts'

test('httpUrl keeps absolute http(s) URLs only', () => {
  expect(httpUrl('https://forge.example.com/acme/widget')).toBe(
    'https://forge.example.com/acme/widget',
  )
  expect(httpUrl('javascript:alert(1)')).toBeUndefined()
  expect(httpUrl('/relative')).toBeUndefined()
  expect(httpUrl(undefined)).toBeUndefined()
})
