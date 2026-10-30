import { describe, expect, test } from 'bun:test'

import { clearCookie, createSessionCodec, readCookie, sessionCookie } from './session.ts'

const secret = 'x'.repeat(32)

describe('createSessionCodec', () => {
  test('round-trips payloads', async () => {
    const codec = createSessionCodec<{ user: string }>(secret)
    expect(await codec.verify(await codec.issue({ user: 'a' }, 60))).toEqual({ user: 'a' })
  })

  test('rejects tampered, foreign and expired tokens', async () => {
    let now = 1_000
    const codec = createSessionCodec<{ user: string }>(secret, () => now)
    const token = await codec.issue({ user: 'a' }, 10)
    const [body, signature] = token.split('.')
    const forged = `${Buffer.from(JSON.stringify({ p: { user: 'b' }, e: 99_999 })).toString('base64url')}.${signature}`

    expect(await codec.verify(forged)).toBeUndefined()
    expect(await codec.verify(`${body}`)).toBeUndefined()
    expect(await createSessionCodec(secret.replace('x', 'y')).verify(token)).toBeUndefined()
    now = 20_000
    expect(await codec.verify(token)).toBeUndefined()
  })

  test('requires a long secret', () => {
    expect(() => createSessionCodec('short')).toThrow('at least 32')
  })
})

describe('cookies', () => {
  test('reads and writes session cookies', () => {
    const request = new Request('http://x', { headers: { cookie: 'a=1; hk_session=abc%3D; b=2' } })
    expect(readCookie(request, 'hk_session')).toBe('abc=')
    expect(readCookie(request, 'missing')).toBeUndefined()
    expect(sessionCookie('s', 'v', { maxAgeSeconds: 60 })).toBe(
      's=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure',
    )
    expect(clearCookie('s')).toContain('Max-Age=0')
  })
})
