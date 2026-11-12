import { afterEach, describe, expect, test } from 'bun:test'

import { ApiError, linkGoneOf, missingOf, request } from './client.ts'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

const respond = (status: number, body: unknown) => {
  globalThis.fetch = Object.assign(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    { preconnect: () => {} },
  )
}

describe('api errors', () => {
  test('a failed request keeps the parsed body next to the message', async () => {
    respond(403, { error: 'missing permission releases:run', missing: { action: 'releases:run' } })
    const error = await request('GET', '/api/x').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(403)
    expect((error as ApiError).message).toBe('missing permission releases:run')
    expect((error as ApiError).body).toEqual({
      error: 'missing permission releases:run',
      missing: { action: 'releases:run' },
    })
  })

  test('a body that is not JSON falls back to the status text', async () => {
    respond(500, 'oops')
    const error = await request('GET', '/api/x').catch((caught: unknown) => caught)
    expect((error as ApiError).body).toBeUndefined()
    expect((error as ApiError).message).toBe('Request failed with 500')
  })

  test('the missing permission comes only from a 403 that names one', () => {
    const body = { error: 'no', missing: { action: 'releases:run', target: 'acme:acme/widgets' } }
    expect(missingOf(new ApiError(403, 'no', body))).toEqual({
      action: 'releases:run',
      target: 'acme:acme/widgets',
    })
    expect(
      missingOf(new ApiError(403, 'no', { error: 'no', missing: { action: 'audits:run' } })),
    ).toEqual({ action: 'audits:run' })
    expect(missingOf(new ApiError(403, 'no', { error: 'no' }))).toBeUndefined()
    expect(missingOf(new ApiError(404, 'no', body))).toBeUndefined()
    expect(missingOf(new Error('no'))).toBeUndefined()
  })

  test('a used or expired link reads its state and time from the 410 body', () => {
    const at = '2026-11-09T10:14:00.000Z'
    expect(linkGoneOf(new ApiError(410, 'gone', { error: 'gone', state: 'used', at }))).toEqual({
      state: 'used',
      at,
    })
    expect(linkGoneOf(new ApiError(410, 'gone', { state: 'lost', at }))).toBeUndefined()
    expect(linkGoneOf(new ApiError(404, 'gone', { state: 'used', at }))).toBeUndefined()
  })
})
