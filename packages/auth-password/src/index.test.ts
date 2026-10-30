import { describe, expect, test } from 'bun:test'

import type { AuthProvider } from '@holtkeeper/auth'

import { passwordAuth } from './index.ts'

const sessionSecret = 's'.repeat(32)

const login = (provider: AuthProvider, password: unknown) =>
  provider.handle?.(
    new Request('http://x/auth/password/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
    '/login',
    undefined,
  )

const withCookie = (response: Response | undefined) =>
  new Request('http://x', {
    headers: { cookie: (response?.headers.get('set-cookie') ?? '').split(';')[0] ?? '' },
  })

describe('passwordAuth', () => {
  test('signs in with the right password and recognizes the session', async () => {
    const provider = passwordAuth({ password: 'hunter2', sessionSecret })
    const response = await login(provider, 'hunter2')
    expect(response?.status).toBe(204)
    expect(response?.headers.get('set-cookie')).toContain('HttpOnly')
    expect(await provider.authenticate(withCookie(response))).toMatchObject({
      id: 'root',
      provider: 'password',
    })
    expect(await provider.authenticate(new Request('http://x'))).toBeUndefined()
  })

  test('rejects wrong passwords and throttles repeated failures', async () => {
    const provider = passwordAuth({ password: 'hunter2', sessionSecret, maxFailuresPerMinute: 2 })
    expect((await login(provider, 'nope'))?.status).toBe(401)
    expect((await login(provider, 42))?.status).toBe(401)
    expect((await login(provider, 'hunter2'))?.status).toBe(429)
  })

  test('changing the password invalidates sessions', async () => {
    const env = { value: 'first' }
    process.env.HK_TEST_PASSWORD = env.value
    const provider = passwordAuth({ password: { env: 'HK_TEST_PASSWORD' }, sessionSecret })
    const cookie = withCookie(await login(provider, 'first'))
    expect(await provider.authenticate(cookie)).toBeDefined()
    process.env.HK_TEST_PASSWORD = 'second'
    expect(await provider.authenticate(cookie)).toBeUndefined()
    delete process.env.HK_TEST_PASSWORD
  })

  test('logs out and ignores other paths', async () => {
    const provider = passwordAuth({ password: 'x', sessionSecret })
    const logout = await provider.handle?.(
      new Request('http://x', { method: 'POST' }),
      '/logout',
      undefined,
    )
    expect(logout?.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(await provider.handle?.(new Request('http://x'), '/login', undefined)).toBeUndefined()
    expect(provider.info().methods).toEqual([{ kind: 'password' }])
  })
})
