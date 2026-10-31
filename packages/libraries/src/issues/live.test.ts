import { describe, expect, test } from 'bun:test'

import { GitHubRateLimitError } from '../github/client.ts'
import { fakeGitHub } from './fake-github.ts'
import { type IssueSearchCache, liveIssueSearch, searchTerms } from './live.ts'

const repo = { host: 'github.com', path: 'acme/left-pad', url: 'https://github.com/acme/left-pad' }

const item = (number: number, overrides: Record<string, unknown> = {}) => ({
  number,
  title: `Issue ${number}`,
  html_url: `https://github.com/acme/left-pad/issues/${number}`,
  state: 'open',
  labels: [{ name: 'bug' }],
  body: 'Body',
  comments: 1,
  reactions: { total_count: 2 },
  created_at: '2026-05-01T00:00:00Z',
  updated_at: '2026-05-02T00:00:00Z',
  ...overrides,
})

const memoryCache = () => {
  const values = new Map<string, unknown>()
  const ttls: number[] = []
  const cache: IssueSearchCache = {
    async get(key) {
      return values.get(key)
    },
    async set(key, value, ttl) {
      values.set(key, value)
      ttls.push(ttl)
    },
  }
  return { cache, values, ttls }
}

describe('searchTerms', () => {
  test('removes qualifiers that could leave the repository', () => {
    expect(searchTerms('crash repo:evil/x is:pr -label:"won\'t fix" now')).toBe('crash now')
    expect(searchTerms('"TypeError: x is not a function"')).toBe('"TypeError: x is not a function"')
  })
})

describe('liveIssueSearch', () => {
  test('searches the repository, skips pull requests and caches a day', async () => {
    const { client, calls } = fakeGitHub({
      rest: () => ({ data: { items: [item(1), item(2, { pull_request: {} }), item(3)] } }),
    })
    const { cache, ttls } = memoryCache()
    const search = liveIssueSearch({ github: client, cache })
    const first = await search(repo, 'crash on empty', 5)
    expect(first.issues.map((issue) => issue.id)).toEqual([
      'github.com/acme/left-pad#1',
      'github.com/acme/left-pad#3',
    ])
    expect(first.issues[0]).toMatchObject({
      kind: 'issue',
      state: 'open',
      labels: ['bug'],
      reactions: 2,
    })
    expect(calls.rest[0]).toBe(
      `/search/issues?q=${encodeURIComponent('crash on empty repo:acme/left-pad is:issue')}&per_page=20`,
    )
    expect(ttls).toEqual([86_400])
    const second = await search(repo, 'Crash on empty', 1)
    expect(second.issues).toHaveLength(1)
    expect(calls.rest).toHaveLength(1)
  })

  test('answers with a note on rate limits and failures', async () => {
    const { client } = fakeGitHub({})
    client.rest = () => Promise.reject(new GitHubRateLimitError(undefined))
    const limited = await liveIssueSearch({ github: client })(repo, 'crash', 5)
    expect(limited.issues).toEqual([])
    expect(limited.note).toContain('rate limit')
    client.rest = () => Promise.reject(new Error('GitHub 500 for /search'))
    const failed = await liveIssueSearch({ github: client })(repo, 'crash', 5)
    expect(failed.note).toContain('GitHub 500')
  })

  test('serves the cache when rate limited', async () => {
    const { cache } = memoryCache()
    const working = fakeGitHub({ rest: () => ({ data: { items: [item(1)] } }) })
    await liveIssueSearch({ github: working.client, cache })(repo, 'crash', 5)
    const { client } = fakeGitHub({})
    client.rest = () => Promise.reject(new GitHubRateLimitError(undefined))
    const hits = await liveIssueSearch({ github: client, cache })(repo, 'crash', 5)
    expect(hits.issues).toHaveLength(1)
    expect(hits.note).toBeUndefined()
  })

  test('other hosts and empty queries do not call GitHub', async () => {
    const { client, calls } = fakeGitHub({})
    const search = liveIssueSearch({ github: client })
    expect((await search({ ...repo, host: 'gitlab.com' }, 'crash', 5)).note).toContain(
      'GitHub only',
    )
    expect((await search(repo, 'repo:x/y', 5)).issues).toEqual([])
    expect(calls.rest).toHaveLength(0)
  })
})
