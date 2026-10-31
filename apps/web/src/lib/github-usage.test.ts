import { describe, expect, test } from 'bun:test'

import type { GitHubRequestCounts } from '@holtkeeper/api'

import {
  byResource,
  dailyChart,
  formatLimit,
  parseGitHubRange,
  savedShare,
  sortResources,
  sumCounts,
  tokenName,
  utilization,
  utilizationColor,
} from './github-usage.ts'

const counts = (requests: number, notModified = 0, limited = 0): GitHubRequestCounts => ({
  requests,
  notModified,
  limited,
  waits: limited ? 1 : 0,
  waitMs: limited ? 1000 : 0,
})

describe('parseGitHubRange', () => {
  test('accepts the offered ranges as numbers or strings', () => {
    expect(parseGitHubRange(7)).toBe(7)
    expect(parseGitHubRange('90')).toBe(90)
  })
  test('rejects anything else', () => {
    expect(parseGitHubRange(14)).toBeUndefined()
    expect(parseGitHubRange('abc')).toBeUndefined()
    expect(parseGitHubRange(undefined)).toBeUndefined()
  })
})

describe('sortResources', () => {
  test('puts core, search and graphql first, the rest alphabetical', () => {
    expect(sortResources(['scim', 'graphql', 'code_search', 'core', 'search'])).toEqual([
      'core',
      'search',
      'graphql',
      'code_search',
      'scim',
    ])
  })
  test('orders record entries the same way', () => {
    expect(byResource({ graphql: 1, core: 2 })).toEqual([
      ['core', 2],
      ['graphql', 1],
    ])
    expect(byResource(undefined)).toEqual([])
  })
})

describe('utilization', () => {
  test('is the used share rounded and clamped', () => {
    expect(utilization({ limit: 5000, used: 1250 })).toBe(25)
    expect(utilization({ limit: 60, used: 61 })).toBe(100)
    expect(utilization({ limit: 0, used: 0 })).toBe(0)
    expect(utilization({ limit: 0, used: 3 })).toBe(100)
  })
  test('colors by how close the limit is', () => {
    expect(utilizationColor(10)).toBe('var(--accent)')
    expect(utilizationColor(75)).toBe('var(--warning)')
    expect(utilizationColor(95)).toBe('var(--danger)')
  })
  test('formats used over limit', () => {
    expect(formatLimit({ limit: 5000, used: 1234 })).toBe('1,234 / 5,000')
  })
})

describe('sumCounts', () => {
  test('adds every resource', () => {
    expect(sumCounts({ core: counts(10, 4, 1), graphql: counts(5, 1) })).toEqual({
      requests: 15,
      notModified: 5,
      limited: 1,
      waits: 1,
      waitMs: 1000,
    })
    expect(sumCounts(undefined).requests).toBe(0)
  })
  test('saved share is the 304 share of requests', () => {
    expect(savedShare(counts(8, 2))).toBe(25)
    expect(savedShare(counts(0))).toBeUndefined()
  })
})

describe('dailyChart', () => {
  const tokens = [
    { credentialId: 'a', name: 'bot-a', usage: {} },
    { credentialId: 'b', name: 'bot-b', usage: {} },
    { credentialId: 'c', name: 'bot-c', usage: {} },
  ]
  const days: { day: string; total: GitHubRequestCounts; byToken: Record<string, number> }[] = [
    { day: '2026-10-01', total: counts(6), byToken: { a: 3, gone: 1, anonymous: 2 } },
    { day: '2026-10-02', total: counts(4), byToken: { a: 1, b: 3 } },
  ]

  test('has a series per token with requests, unlisted tokens and anonymous last', () => {
    const chart = dailyChart({ tokens, days })
    expect(chart.series).toEqual([
      { key: 's0', label: 'bot-a' },
      { key: 's1', label: 'bot-b' },
      { key: 's2', label: 'gone' },
      { key: 's3', label: 'Anonymous' },
    ])
    expect(chart.data).toEqual([
      { day: 'Oct 1', s0: 3, s1: 0, s2: 1, s3: 2 },
      { day: 'Oct 2', s0: 1, s1: 3, s2: 0, s3: 0 },
    ])
  })
  test('names tokens by credential id', () => {
    expect(tokenName(tokens, 'b')).toBe('bot-b')
    expect(tokenName(tokens, 'x')).toBe('x')
  })
})
