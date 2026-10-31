import { describe, expect, test } from 'bun:test'

import { type GitHubCache, GitHubRateLimitError, createGitHubClient } from './client.ts'

interface Call {
  url: string
  token?: string
  ifNoneMatch?: string
}

type Answer = (call: Call) => Response

function fakeFetch(answer: Answer) {
  const calls: Call[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const auth = headers.get('authorization')
    const call: Call = {
      url: input instanceof Request ? input.url : input.toString(),
      ...(auth ? { token: auth.replace('Bearer ', '') } : {}),
      ...(headers.get('if-none-match') ? { ifNoneMatch: headers.get('if-none-match')! } : {}),
    }
    calls.push(call)
    return answer(call)
  }) as typeof fetch
  return { fetchFn, calls }
}

const json = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(body), { status, headers })

const limited = (resetSeconds: number) =>
  new Response('{"message":"API rate limit exceeded"}', {
    status: 403,
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSeconds) },
  })

function memoryCache(): GitHubCache & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    async get(key) {
      return data.get(key)
    },
    async set(key, value) {
      data.set(key, value)
    },
  }
}

const users = (logins: Record<string, string>) => (call: Call) =>
  call.url.endsWith('/user') ? json({ login: logins[call.token ?? ''] }) : undefined

describe('createGitHubClient token pool', () => {
  test('sends each request with the token that has the most of the limit left', async () => {
    const remaining: Record<string, number> = { a: 10, b: 4000 }
    const { fetchFn, calls } = fakeFetch(
      (call) =>
        users({ a: 'org-a-bot', b: 'org-b-bot' })(call) ??
        json([], { 'x-ratelimit-remaining': String(remaining[call.token!]!--) }),
    )
    const client = createGitHubClient({ tokens: ['a', 'b'], fetch: fetchFn })
    await client.rest('/repos/x/y/tags')
    await client.rest('/repos/x/y/tags')
    await client.rest('/repos/x/y/tags')
    const api = calls.filter((call) => !call.url.endsWith('/user'))
    expect(api.map((call) => call.token)).toEqual(['a', 'b', 'b'])
  })

  test('moves to another token when one runs out, without waiting', async () => {
    const sleeps: number[] = []
    const { fetchFn, calls } = fakeFetch(
      (call) =>
        users({ a: 'one', b: 'two' })(call) ??
        (call.token === 'a' ? limited(2_000_000_000) : json({ ok: true })),
    )
    const client = createGitHubClient({
      tokens: ['a', 'b'],
      fetch: fetchFn,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    for (let i = 0; i < 3; i++) {
      // oxlint-disable-next-line no-await-in-loop -- requests in order
      expect((await client.rest('/repos/x/y')).data).toEqual({ ok: true })
    }
    expect(sleeps).toEqual([])
    const api = calls.filter((call) => !call.url.endsWith('/user'))
    expect(api.map((call) => call.token)).toEqual(['a', 'b', 'b', 'b'])
  })

  test('waits for the reset when every token is exhausted, then continues', async () => {
    let clock = 1_000_000
    const resetAt = clock / 1000 + 600
    let exhausted = true
    const sleeps: number[] = []
    const { fetchFn } = fakeFetch(() => (exhausted ? limited(resetAt) : json({ ok: 1 })))
    const client = createGitHubClient({
      token: 'a',
      fetch: fetchFn,
      maxWaitMs: 3_600_000,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms)
        clock += ms
        exhausted = false
      },
    })
    expect((await client.rest('/repos/x/y')).data).toEqual({ ok: 1 })
    expect(sleeps).toEqual([600_000])
  })

  test('throws GitHubRateLimitError when the reset is further away than maxWaitMs', async () => {
    const clock = 1_000_000
    const { fetchFn } = fakeFetch(() => limited(clock / 1000 + 7200))
    const client = createGitHubClient({ token: 'a', fetch: fetchFn, now: () => clock })
    expect(client.rest('/repos/x/y')).rejects.toBeInstanceOf(GitHubRateLimitError)
  })

  test('honours Retry-After of a secondary limit', async () => {
    let clock = 0
    let first = true
    const sleeps: number[] = []
    const { fetchFn } = fakeFetch(() => {
      if (!first) return json({ ok: 2 })
      first = false
      return new Response('{}', { status: 403, headers: { 'retry-after': '30' } })
    })
    const client = createGitHubClient({
      token: 'a',
      fetch: fetchFn,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms)
        clock += ms
      },
    })
    expect((await client.rest('/search/issues?q=x')).data).toEqual({ ok: 2 })
    expect(sleeps).toEqual([30_000])
  })

  test('counts search apart from core, so an exhausted search limit leaves core alone', async () => {
    const clock = 1_000_000
    const { fetchFn } = fakeFetch((call) =>
      call.url.includes('/search/') ? limited(clock / 1000 + 7200) : json({ ok: 3 }),
    )
    const client = createGitHubClient({ token: 'a', fetch: fetchFn, now: () => clock })
    expect(client.rest('/search/issues?q=x')).rejects.toBeInstanceOf(GitHubRateLimitError)
    expect((await client.rest('/repos/x/y')).data).toEqual({ ok: 3 })
  })

  test('drops a token of an account already in the pool and says so', async () => {
    const lines: string[] = []
    const { fetchFn, calls } = fakeFetch(
      (call) => users({ a: 'same', b: 'same' })(call) ?? json({ ok: 4 }),
    )
    const client = createGitHubClient({
      tokens: ['a', 'b'],
      fetch: fetchFn,
      log: (line) => lines.push(line),
    })
    await client.rest('/repos/x/y')
    await client.rest('/repos/x/y')
    const api = calls.filter((call) => !call.url.endsWith('/user'))
    expect(new Set(api.map((call) => call.token)).size).toBe(1)
    expect(lines.join('\n')).toContain('share one rate limit')
  })

  test('stops waiting when the signal aborts', async () => {
    const controller = new AbortController()
    const { fetchFn } = fakeFetch(() => limited(Date.now() / 1000 + 600))
    const client = createGitHubClient({
      token: 'a',
      fetch: fetchFn,
      maxWaitMs: 3_600_000,
      signal: controller.signal,
    })
    const pending = client.rest('/repos/x/y')
    setTimeout(() => controller.abort(new Error('stopped')), 10)
    expect(pending).rejects.toThrow('stopped')
    await pending.catch(() => {})
  })
})

describe('createGitHubClient conditional requests', () => {
  test('sends If-None-Match and answers a 304 from the cache', async () => {
    const cache = memoryCache()
    const { fetchFn, calls } = fakeFetch((call) =>
      call.ifNoneMatch === '"v1"'
        ? new Response(null, { status: 304 })
        : json([{ name: 'v1.0.0' }], {
            etag: '"v1"',
            link: '<https://api.github.com/next>; rel="next"',
          }),
    )
    const client = createGitHubClient({ token: 'a', fetch: fetchFn, cache })
    const first = await client.rest('/repos/x/y/tags')
    const second = await client.rest('/repos/x/y/tags')
    expect(second).toEqual(first)
    expect(second).toEqual({
      status: 200,
      data: [{ name: 'v1.0.0' }],
      next: 'https://api.github.com/next',
    })
    expect(calls.map((call) => call.ifNoneMatch)).toEqual([undefined, '"v1"'])
  })

  test('replaces the cached body when the resource changed', async () => {
    const cache = memoryCache()
    let version = 1
    const { fetchFn } = fakeFetch((call) =>
      call.ifNoneMatch === `"v${version}"`
        ? new Response(null, { status: 304 })
        : json({ version }, { etag: `"v${version}"` }),
    )
    const client = createGitHubClient({ token: 'a', fetch: fetchFn, cache })
    await client.rest('/repos/x/y')
    version = 2
    expect((await client.rest('/repos/x/y')).data).toEqual({ version: 2 })
    expect((await client.rest('/repos/x/y')).data).toEqual({ version: 2 })
  })
})
