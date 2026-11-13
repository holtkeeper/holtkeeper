import { describe, expect, test } from 'bun:test'

import { latestGoGuidelinesTag, refreshGoGuidelines } from './fetch.ts'
import type { StoredGoGuidelines } from './schema.ts'

const data = JSON.stringify([
  {
    id: 'widget_loop',
    since_version: '1.22',
    guideline: 'Range over integers.',
    details: 'Shorter loops.',
    examples: [{ before: ['for i := 0; i < n; i++ {}'], after: ['for i := range n {}'] }],
  },
])

const now = new Date('2026-11-13T08:00:00Z')

function fakeFetch(routes: Record<string, () => Response>) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))
    return route ? route[1]() : new Response('missing', { status: 404 })
  }
  return { fetch, calls }
}

const TAGS = 'https://api.github.com/repos/JetBrains/go-modern-guidelines/tags'
const RAW = 'https://raw.githubusercontent.com/JetBrains/go-modern-guidelines/'
const tags =
  (names: string[], etag = 'W/"t1"') =>
  () =>
    Response.json(
      names.map((name) => ({ name })),
      { headers: { etag } },
    )

const previous: StoredGoGuidelines = {
  tag: 'v0.1.1',
  fetchedAt: '2026-11-01T00:00:00.000Z',
  checkedAt: '2026-11-01T00:00:00.000Z',
  tagsEtag: 'W/"t0"',
  count: 1,
  guidelines: JSON.parse(data),
}

describe('latestGoGuidelinesTag', () => {
  test('picks the newest stable release tag', () => {
    expect(latestGoGuidelinesTag(['v0.1.0', 'v0.10.0-dev.1', 'v0.2.0', 'v0.10.0', 'main'])).toBe(
      'v0.10.0',
    )
    expect(latestGoGuidelinesTag(['v0.1.0-dev.1', 'nightly'])).toBeUndefined()
  })
})

describe('refreshGoGuidelines', () => {
  test('downloads the data of the newest release tag', async () => {
    const { fetch, calls } = fakeFetch({
      [TAGS]: tags(['v0.1.0-dev.1', 'v0.1.1', 'v0.1.0']),
      [RAW]: () => new Response(data),
    })
    const result = await refreshGoGuidelines({ fetch, now })
    expect(result).toMatchObject({
      status: 'updated',
      stored: { tag: 'v0.1.1', count: 1, tagsEtag: 'W/"t1"', fetchedAt: now.toISOString() },
    })
    expect(calls[1]?.url).toBe(`${RAW}v0.1.1/internal/guidelines/guidelines.json`)
    expect(calls[0]?.headers['if-none-match']).toBeUndefined()
  })

  test('keeps the copy when the listing is unchanged (304) or names the same tag', async () => {
    const notModified = fakeFetch({ [TAGS]: () => new Response(null, { status: 304 }) })
    const result = await refreshGoGuidelines({ fetch: notModified.fetch, previous, now })
    expect(result).toEqual({
      status: 'unchanged',
      stored: { ...previous, checkedAt: now.toISOString() },
    })
    expect(notModified.calls[0]?.headers['if-none-match']).toBe('W/"t0"')

    const same = fakeFetch({ [TAGS]: tags(['v0.1.1', 'v0.1.0'], 'W/"t2"') })
    const again = await refreshGoGuidelines({ fetch: same.fetch, previous, now })
    expect(again).toMatchObject({ status: 'unchanged', stored: { tagsEtag: 'W/"t2"' } })
    expect(same.calls).toHaveLength(1)
  })

  test('fails without throwing on invalid data, rate limits and network errors', async () => {
    const invalid = fakeFetch({
      [TAGS]: tags(['v0.2.0']),
      [RAW]: () => new Response('[{"id":"x"}]'),
    })
    expect(await refreshGoGuidelines({ fetch: invalid.fetch, previous, now })).toMatchObject({
      status: 'failed',
    })

    const limited = fakeFetch({
      [TAGS]: () =>
        new Response('{}', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1794556800' },
        }),
    })
    const limit = await refreshGoGuidelines({ fetch: limited.fetch, now })
    expect(limit.status === 'failed' && limit.error).toContain('rate limit')

    const broken = await refreshGoGuidelines({
      fetch: async () => {
        throw new Error('connection refused')
      },
      now,
    })
    expect(broken).toEqual({ status: 'failed', error: 'connection refused' })
  })

  test('downloads a pinned tag without listing tags', async () => {
    const { fetch, calls } = fakeFetch({ [RAW]: () => new Response(data) })
    const result = await refreshGoGuidelines({ fetch, tag: 'v0.1.0', now })
    expect(result).toMatchObject({ status: 'updated', stored: { tag: 'v0.1.0' } })
    expect(calls.map((call) => call.url)).toEqual([
      `${RAW}v0.1.0/internal/guidelines/guidelines.json`,
    ])
    expect(await refreshGoGuidelines({ fetch, tag: 'latest', now })).toMatchObject({
      status: 'failed',
    })
  })
})
