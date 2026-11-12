import { describe, expect, test } from 'bun:test'

import { isCancelled, linkGrantsText, passkeyName } from './passkeys.ts'

describe('passkeys', () => {
  test('names fall back to the position', () => {
    expect(passkeyName({ label: 'MacBook' }, 0)).toBe('MacBook')
    expect(passkeyName({ label: '  ' }, 1)).toBe('Passkey 2')
    expect(passkeyName({}, 2)).toBe('Passkey 3')
  })

  test('a declined browser prompt counts as cancelled', () => {
    expect(isCancelled(Object.assign(new Error('no'), { name: 'NotAllowedError' }))).toBeTrue()
    expect(isCancelled(Object.assign(new Error('no'), { name: 'AbortError' }))).toBeTrue()
    expect(isCancelled(new Error('passkey is already registered'))).toBeFalse()
    expect(isCancelled('NotAllowedError')).toBeFalse()
  })

  test('a link names the role and how many grants, nothing about their scopes', () => {
    expect(linkGrantsText({ count: 1, role: 'viewer' })).toBe('Viewer access · 1 grant')
    expect(linkGrantsText({ count: 3, role: 'custom' })).toBe('Custom access · 3 grants')
    expect(linkGrantsText({ count: 0, role: 'none' })).toBe('No access yet')
  })
})
