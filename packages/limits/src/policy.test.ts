import { describe, expect, test } from 'bun:test'

import { retryDelayFrom, throttleHintFrom } from './headers.ts'
import {
  defaultLimitPolicy,
  limitPolicySchema,
  limitsCredentialsSetting,
  resolveLimitPolicy,
} from './policy.ts'
import { memoryLimiterState } from './state.ts'
import { failure } from './test-helpers.ts'

const now = Date.parse('2026-10-30T10:00:00.000Z')

describe('retryDelayFrom', () => {
  test('prefers retry-after-ms and Retry-After', () => {
    expect(retryDelayFrom(new Headers({ 'retry-after-ms': '250', 'retry-after': '9' }), now)).toBe(
      250,
    )
    expect(retryDelayFrom(new Headers({ 'Retry-After': '3' }), now)).toBe(3000)
    expect(retryDelayFrom({ 'Retry-After': 'Fri, 30 Oct 2026 10:00:07 GMT' }, now)).toBe(7000)
    expect(retryDelayFrom({ 'retry-after': '-5' }, now)).toBe(0)
  })

  test('reads reset headers of GitLab, OpenAI-style and Anthropic APIs', () => {
    expect(retryDelayFrom({ 'RateLimit-Reset': String(now / 1000 + 12) }, now)).toBe(12_000)
    expect(retryDelayFrom({ 'x-ratelimit-reset': '4' }, now)).toBe(4000)
    expect(
      retryDelayFrom(
        { 'x-ratelimit-reset-requests': '1m2s', 'x-ratelimit-reset-tokens': '20ms' },
        now,
      ),
    ).toBe(62_000)
    expect(
      retryDelayFrom(
        {
          'anthropic-ratelimit-requests-remaining': '10',
          'anthropic-ratelimit-requests-reset': '2026-10-30T10:01:00Z',
          'anthropic-ratelimit-input-tokens-remaining': '0',
          'anthropic-ratelimit-input-tokens-reset': '2026-10-30T10:00:15Z',
        },
        now,
      ),
    ).toBe(15_000)
    expect(retryDelayFrom({ 'x-ratelimit-reset': 'soon' }, now)).toBeUndefined()
    expect(retryDelayFrom(new Headers(), now)).toBeUndefined()
  })
})

describe('throttleHintFrom', () => {
  test('recognizes rate-limit errors by status, type and message', () => {
    const withHeaders = Object.assign(new Error('boom'), {
      status: 429,
      headers: new Headers({ 'retry-after': '2' }),
    })
    expect(throttleHintFrom(withHeaders, [429], now)).toEqual({ delayMs: 2000 })
    expect(throttleHintFrom({ error: { type: 'rate_limit_error' } }, [429], now)).toEqual({})
    expect(throttleHintFrom(new Error('Rate limit reached for model'), [429], now)).toEqual({})
    expect(
      throttleHintFrom(Object.assign(new Error('x'), { status: 529 }), [429, 529], now),
    ).toEqual({})
    expect(
      throttleHintFrom(Object.assign(new Error('x'), { status: 500 }), [429], now),
    ).toBeUndefined()
  })
})

describe('policies', () => {
  test('the schema accepts policies and rejects typos', () => {
    expect(
      limitPolicySchema.parse({
        maxConcurrent: 3,
        tokensPerMinute: 80_000,
        backoff: { onStatus: [429], baseMs: 500, maxMs: 30_000 },
      }),
    ).toMatchObject({ maxConcurrent: 3 })
    expect(limitPolicySchema.safeParse({ maxConcurent: 3 }).success).toBe(false)
    expect(limitPolicySchema.safeParse({ maxConcurrent: 0 }).success).toBe(false)
    expect(limitsCredentialsSetting).toMatchObject({
      key: 'limits.credentials',
      section: 'Runtime',
    })
    expect(
      limitsCredentialsSetting.schema.safeParse({ 'corp-ai': { tokensPerDay: 5_000_000 } }).success,
    ).toBe(true)
  })

  test('defaults per credential kind', () => {
    expect(defaultLimitPolicy({ id: '1', kind: 'gitlab' })).toMatchObject({
      maxConcurrent: 8,
      requestsPerMinute: 300,
    })
    expect(
      defaultLimitPolicy({ id: '2', kind: 'ai', options: { tokensPerMinute: 40_000 } }),
    ).toMatchObject({
      maxConcurrent: 3,
      tokensPerMinute: 40_000,
      backoff: { onStatus: [429, 529] },
    })
    expect(
      defaultLimitPolicy({
        id: '3',
        kind: 'anthropic',
        options: { limits: { tokensPerMinute: 9 } },
      }).tokensPerMinute,
    ).toBe(9)
    expect(defaultLimitPolicy({ id: '4', kind: 'ai' }).tokensPerMinute).toBeUndefined()
    expect(defaultLimitPolicy({ id: '5', kind: 'slack' }).maxConcurrent).toBeUndefined()
  })

  test('configured entries override defaults by id, then by name', () => {
    const credential = { id: 'c1', name: 'corp-gitlab', kind: 'gitlab' }
    expect(resolveLimitPolicy(credential, { 'corp-gitlab': { maxConcurrent: 2 } })).toMatchObject({
      maxConcurrent: 2,
      requestsPerMinute: 300,
    })
    expect(
      resolveLimitPolicy(credential, {
        'corp-gitlab': { maxConcurrent: 2 },
        c1: { maxConcurrent: 4 },
      }).maxConcurrent,
    ).toBe(4)
    expect(resolveLimitPolicy(credential).maxConcurrent).toBe(8)
  })
})

describe('memoryLimiterState', () => {
  test('commits nothing when a change throws', async () => {
    const state = memoryLimiterState(() => now)
    await state.transact('k', (s) => {
      s.inFlight = 2
    })
    expect(
      await failure(
        state.transact('k', (s) => {
          s.inFlight = 9
          throw new Error('conflict')
        }),
      ),
    ).toHaveProperty('message', 'conflict')
    expect((await state.read('k'))?.inFlight).toBe(2)
    expect(await state.keys()).toEqual(['k'])
  })
})
