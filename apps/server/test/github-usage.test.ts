import { describe, expect, test } from 'bun:test'

import { memoryStore } from '@holtkeeper/store/memory'

import {
  githubReferences,
  githubTokenUsage,
  githubUsage,
  resolveGitHubTokens,
} from '../src/github-usage.ts'

const request = (resource: 'core' | 'search' | 'graphql', extra = {}) => ({
  kind: 'request' as const,
  resource,
  status: 200,
  notModified: false,
  limited: false,
  ...extra,
})

const now = () => new Date('2026-10-31T12:00:00Z')

const limits = (core: number, used: number) => ({
  core: { limit: core, used, remaining: core - used, resetAt: '2026-10-31T13:00:00.000Z' },
})

describe('githubUsage', () => {
  test('merges counts of several processes per day, token and resource', async () => {
    const store = memoryStore()
    const a = githubUsage({ kv: store.kv!, now })
    const b = githubUsage({ kv: store.kv!, now })
    a.record(request('core'), 'c1')
    a.record(request('core', { status: 304, notModified: true }), 'c1')
    b.record(request('core', { status: 403, limited: true }), 'c1')
    b.record(request('search'))
    b.record({ kind: 'wait', resource: 'core', ms: 2000 })
    await a.flush()
    await b.flush()
    const [day] = await githubUsage({ kv: store.kv!, now }).days('2026-10-31', '2026-10-31')
    expect(day?.counts['c1']?.['core']).toEqual({
      requests: 3,
      notModified: 1,
      limited: 1,
      waits: 0,
      waitMs: 0,
    })
    expect(day?.counts['anonymous']?.['search']?.requests).toBe(1)
    expect(day?.counts['pool']?.['core']).toMatchObject({ waits: 1, waitMs: 2000 })
  })
})

describe('githubTokenUsage', () => {
  test('sums capacity over distinct accounts and marks duplicates', async () => {
    const usage = githubUsage({ now })
    usage.record(request('core'), 'c1')
    usage.record(request('core'), 'c2')
    usage.record(request('core'), 'c2')
    const accounts: Record<string, { login: string; limits: ReturnType<typeof limits> }> = {
      t1: { login: 'bot-a', limits: limits(5000, 100) },
      t2: { login: 'bot-b', limits: limits(5000, 4000) },
      t3: { login: 'bot-a', limits: limits(5000, 100) },
    }
    const result = await githubTokenUsage({
      credentials: [
        { id: 'c1', name: 'org-a', token: 't1' },
        { id: 'c2', name: 'org-b', token: 't2' },
        { id: 'c3', name: 'org-a-again', token: 't3' },
        { id: 'c4', name: 'sealed', error: 'cannot open' },
      ],
      usage,
      days: 3,
      now,
      info: async (token) => accounts[token ?? ''] ?? {},
    })
    expect(result.tokens.map((token) => [token.name, token.login, token.duplicateOf])).toEqual([
      ['org-a', 'bot-a', undefined],
      ['org-b', 'bot-b', undefined],
      ['org-a-again', 'bot-a', 'c1'],
      ['sealed', undefined, undefined],
    ])
    expect(result.tokens[3]?.error).toBe('cannot open')
    expect(result.capacity['core']).toMatchObject({ limit: 10_000, used: 4100, remaining: 5900 })
    expect(result.tokens[1]?.usage['core']?.requests).toBe(2)
    expect(result.days.map((day) => day.day)).toEqual(['2026-10-29', '2026-10-30', '2026-10-31'])
    expect(result.days.at(-1)?.byToken).toEqual({ c1: 1, c2: 2 })
    expect(result.totals.requests).toBe(3)
  })
})

describe('resolveGitHubTokens', () => {
  test('reads each named credential once and reports the rest', async () => {
    const resolved = await resolveGitHubTokens(
      {
        list: async () => [
          { id: 'c1', name: 'org-a' },
          { id: 'c2', name: 'broken' },
        ],
        reveal: async (id) => {
          if (id === 'c2') throw new Error('sealed')
          return 'secret'
        },
      },
      ['org-a', 'c1', 'broken', 'gone'],
    )
    expect(resolved).toEqual([
      { id: 'c1', name: 'org-a', token: 'secret' },
      { id: 'c2', name: 'broken', error: 'sealed' },
      { id: 'gone', name: 'gone', error: 'no credential "gone"' },
    ])
  })
})

describe('githubReferences', () => {
  test('stands for every github credential when unset, and for itself otherwise', async () => {
    const credentials = {
      list: async () => [
        { id: 'c1', name: 'a', kind: 'github' },
        { id: 'c2', name: 'b', kind: 'gitlab' },
        { id: 'c3', name: 'c', kind: 'github' },
      ],
    }
    expect(await githubReferences(credentials, undefined)).toEqual(['c1', 'c3'])
    expect(await githubReferences(credentials, ['b'])).toEqual(['b'])
    expect(await githubReferences(credentials, [])).toEqual([])
  })
})
