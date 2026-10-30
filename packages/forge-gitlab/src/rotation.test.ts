import { describe, expect, test } from 'bun:test'

import { GitLabApiError, gitlabTokenRotator } from './rotation.ts'

async function errorOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error('expected a rejection')
}

const TOKEN = 'glpat-old-secret'

interface Call {
  url: string
  init: RequestInit
}

function fakeFetch(status: number, body: unknown) {
  const calls: Call[] = []
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    init.signal?.throwIfAborted()
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    return new Response(text, { status, headers: { 'Content-Type': 'application/json' } })
  }
  return { fetch, calls }
}

const now = () => new Date('2026-10-30T15:00:00Z')

const tokenBody = {
  id: 42,
  name: 'holtkeeper',
  revoked: false,
  scopes: ['api', 'self_rotate'],
  active: true,
  expires_at: '2026-11-20',
}

describe('inspect', () => {
  test('reads the token itself', async () => {
    const { fetch, calls } = fakeFetch(200, tokenBody)
    const info = await gitlabTokenRotator({ fetch }).inspect?.({
      url: 'https://gitlab.example.com',
      token: TOKEN,
    })

    expect(info).toEqual({
      name: 'holtkeeper',
      scopes: ['api', 'self_rotate'],
      expiresAt: '2026-11-20T00:00:00.000Z',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://gitlab.example.com/api/v4/personal_access_tokens/self')
    expect(calls[0]?.init.method).toBe('GET')
    expect(calls[0]?.init.redirect).toBe('error')
    expect(calls[0]?.init.headers).toEqual({ 'PRIVATE-TOKEN': TOKEN, Accept: 'application/json' })
    expect(calls[0]?.init.body).toBeUndefined()
  })

  test('leaves expiresAt out for tokens without expiry', async () => {
    const { fetch } = fakeFetch(200, { ...tokenBody, expires_at: null })
    const info = await gitlabTokenRotator({ fetch }).inspect?.({
      url: 'https://gitlab.example.com',
      token: TOKEN,
    })
    expect(info).toEqual({ name: 'holtkeeper', scopes: ['api', 'self_rotate'] })
  })

  test.each([
    [
      'https://gitlab.example.com/',
      'https://gitlab.example.com/api/v4/personal_access_tokens/self',
    ],
    ['https://example.com/gitlab', 'https://example.com/gitlab/api/v4/personal_access_tokens/self'],
    [
      'https://example.com/gitlab//',
      'https://example.com/gitlab/api/v4/personal_access_tokens/self',
    ],
    ['http://localhost:8080/', 'http://localhost:8080/api/v4/personal_access_tokens/self'],
  ])('builds the API URL from %s', async (url, expected) => {
    const { fetch, calls } = fakeFetch(200, tokenBody)
    await gitlabTokenRotator({ fetch }).inspect?.({ url, token: TOKEN })
    expect(calls[0]?.url).toBe(expected)
  })
})

describe('rotate', () => {
  test('rotates with an expiry lifetimeDays from now', async () => {
    const { fetch, calls } = fakeFetch(200, {
      ...tokenBody,
      token: 'glpat-new-secret',
      expires_at: '2027-01-28',
    })
    const rotated = await gitlabTokenRotator({ fetch, now }).rotate({
      url: 'https://example.com/gitlab/',
      token: TOKEN,
      lifetimeDays: 90,
    })

    expect(rotated).toEqual({ token: 'glpat-new-secret', expiresAt: '2027-01-28T00:00:00.000Z' })
    expect(calls[0]?.url).toBe(
      'https://example.com/gitlab/api/v4/personal_access_tokens/self/rotate',
    )
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.init.headers).toEqual({
      'PRIVATE-TOKEN': TOKEN,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    })
    expect(calls[0]?.init.body).toBe('{"expires_at":"2027-01-28"}')
  })

  test('maps GitLab errors with status and message, without the token', async () => {
    const { fetch } = fakeFetch(401, { message: `401 Unauthorized ${TOKEN}` })
    const error = await errorOf(
      gitlabTokenRotator({ fetch, now }).rotate({
        url: 'https://gitlab.example.com',
        token: TOKEN,
        lifetimeDays: 30,
      }),
    )

    expect(error).toBeInstanceOf(GitLabApiError)
    expect(error).toHaveProperty('status', 401)
    expect(error.message).toBe(
      'GitLab POST /api/v4/personal_access_tokens/self/rotate failed with 401: 401 Unauthorized [redacted]',
    )
  })

  test('explains 405 for tokens that are not personal access tokens', async () => {
    const { fetch } = fakeFetch(405, { message: '405 Method Not Allowed' })
    const rotator = gitlabTokenRotator({ fetch, now })
    const promise = rotator.rotate({
      url: 'https://gitlab.example.com',
      token: TOKEN,
      lifetimeDays: 30,
    })
    expect((await errorOf(promise)).message).toMatch(
      /failed with 405: 405 Method Not Allowed \(only personal access tokens/,
    )
  })

  test.each([
    [
      400,
      { message: { expires_at: ['must be before 2027-10-30'] } },
      '{"expires_at":["must be before 2027-10-30"]}',
    ],
    [403, { error: 'insufficient_scope', error_description: 'needs api' }, 'needs api'],
    [502, '<html>Bad Gateway</html>', 'no error message'],
  ])('maps a %d body', async (status, body, message) => {
    const { fetch } = fakeFetch(status, body)
    const promise = gitlabTokenRotator({ fetch, now }).rotate({
      url: 'https://g.example',
      token: TOKEN,
      lifetimeDays: 1,
    })
    expect((await errorOf(promise)).message).toMatch(`failed with ${status}: ${message}`)
  })

  test('rejects an unexpected success body without echoing it', async () => {
    const { fetch } = fakeFetch(200, { token: 123, expires_at: '2027-01-28', secret: TOKEN })
    const promise = gitlabTokenRotator({ fetch, now }).rotate({
      url: 'https://g.example',
      token: TOKEN,
      lifetimeDays: 1,
    })
    const error = await errorOf(promise)
    expect(error.message).toBe(
      'GitLab POST /api/v4/personal_access_tokens/self/rotate returned an unexpected response (token)',
    )
    expect(error.message).not.toContain(TOKEN)
  })

  test('passes the abort signal to fetch', async () => {
    const { fetch, calls } = fakeFetch(200, tokenBody)
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    const promise = gitlabTokenRotator({ fetch, now }).rotate({
      url: 'https://g.example',
      token: TOKEN,
      lifetimeDays: 1,
      signal: controller.signal,
    })
    expect((await errorOf(promise)).message).toMatch('stopped')
    expect(calls[0]?.init.signal).toBe(controller.signal)
  })

  test('refuses a non-positive lifetime before calling GitLab', async () => {
    const { fetch, calls } = fakeFetch(200, tokenBody)
    const promise = gitlabTokenRotator({ fetch, now }).rotate({
      url: 'https://g.example',
      token: TOKEN,
      lifetimeDays: 0,
    })
    expect((await errorOf(promise)).message).toMatch('lifetimeDays must be a positive integer')
    expect(calls).toHaveLength(0)
  })
})
