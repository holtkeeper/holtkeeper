import { describe, expect, test } from 'bun:test'

import { isCancelled, passkeyName } from './passkeys.ts'

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
})
