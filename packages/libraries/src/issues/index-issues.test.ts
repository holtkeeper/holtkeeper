import { describe, expect, test } from 'bun:test'

import { memoryStore } from '@holtkeeper/store/memory'

import { GitHubRateLimitError } from '../github/client.ts'
import { fakeGitHub, library } from './fake-github.ts'
import {
  indexIssues,
  issueWindowStart,
  keepThread,
  packageRelevance,
  packageTokens,
} from './index-issues.ts'
import { cleanBody, fixedInText, versionOfMilestone } from './shared.ts'

const now = new Date('2026-10-01T00:00:00.000Z')

const libraries = () => {
  const store = memoryStore().libraries
  if (!store) throw new Error('memory store has no libraries')
  return store
}

const rest = (number: number, overrides: Record<string, unknown> = {}) => ({
  number,
  title: `Issue ${number}`,
  html_url: `https://github.com/acme/left-pad/issues/${number}`,
  state: 'closed',
  labels: [],
  body: 'Body',
  comments: 0,
  reactions: { total_count: 0 },
  created_at: '2026-05-01T00:00:00Z',
  updated_at: `2026-06-${String(number).padStart(2, '0')}T00:00:00Z`,
  closed_at: '2026-06-01T00:00:00Z',
  ...overrides,
})

const graphIssue = (number: number, overrides: Record<string, unknown> = {}) => ({
  number,
  title: `Issue ${number}`,
  url: `https://github.com/acme/left-pad/issues/${number}`,
  state: 'CLOSED',
  stateReason: 'COMPLETED',
  body: 'Body',
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: `2026-06-${String(number).padStart(2, '0')}T00:00:00Z`,
  closedAt: '2026-06-01T00:00:00Z',
  milestone: null,
  labels: { nodes: [] },
  reactions: { totalCount: 0 },
  comments: { totalCount: 0, nodes: [] },
  closedByPullRequestsReferences: { nodes: [] },
  timelineItems: { nodes: [] },
  ...overrides,
})

const page = (key: 'issues' | 'discussions', nodes: unknown[], endCursor?: string) => ({
  repository: {
    [key]: {
      pageInfo: { hasNextPage: endCursor !== undefined, endCursor: endCursor ?? null },
      nodes,
    },
  },
})

describe('helpers', () => {
  test('cleanBody drops template noise and trims', () => {
    const body =
      '<!-- describe the bug -->\n### Describe\nIt crashes\n\n\n\n### Checklist\n- [x] I searched\n### Extra\n'
    expect(cleanBody(body)).toBe('### Describe\nIt crashes')
    expect(cleanBody('x'.repeat(3000)).length).toBe(2000)
  })

  test('cleanBody never splits a surrogate pair', () => {
    const trimmed = cleanBody(`${'x'.repeat(1998)}🎨${'y'.repeat(100)}`)
    expect(trimmed).toBe(`${'x'.repeat(1998)}…`)
    expect(trimmed.isWellFormed()).toBe(true)
  })

  test('versions from milestones and comments', () => {
    expect(versionOfMilestone('v1.2.3')).toBe('1.2.3')
    expect(versionOfMilestone('@babel/core@7.4.0')).toBe('7.4.0')
    expect(versionOfMilestone('Backlog')).toBeUndefined()
    expect(fixedInText('This was fixed in v2.0.1, thanks')).toBe('2.0.1')
    expect(fixedInText('Released in `left-pad@1.4.0`')).toBe('1.4.0')
    expect(fixedInText('fixed it locally')).toBeUndefined()
  })

  test('window starts six months before the oldest used release, else two years back', () => {
    expect(issueWindowStart(now, '2026-07-01T00:00:00Z')).toBe('2026-01-01T00:00:00.000Z')
    expect(issueWindowStart(now)).toBe('2024-10-01T00:00:00.000Z')
  })

  test('keep rules', () => {
    const base = {
      id: 'x',
      number: 1,
      kind: 'issue' as const,
      title: 't',
      state: 'closed' as const,
      labels: [],
      url: '',
      body: '',
      pulls: [],
      reactions: 0,
      comments: 0,
      createdAt: '',
      updatedAt: '',
    }
    expect(keepThread(base, 5)).toBe(false)
    expect(keepThread({ ...base, labels: ['Type: Bug'] }, 5)).toBe(true)
    expect(keepThread({ ...base, labels: ['breaking change'] }, 5)).toBe(true)
    expect(keepThread({ ...base, pulls: [3] }, 5)).toBe(true)
    expect(keepThread({ ...base, reactions: 5 }, 5)).toBe(true)
    expect(keepThread({ ...base, kind: 'discussion' }, 5)).toBe(false)
    expect(keepThread({ ...base, kind: 'discussion', answer: 'yes' }, 5)).toBe(true)
  })

  test('monorepo relevance', () => {
    const tokens = packageTokens('@babel/core', 'packages/babel-core')
    expect(tokens).toEqual(['@babel/core', 'babel-core'])
    expect(packageRelevance({ title: '@babel/core crashes', labels: [] }, tokens)).toBe('match')
    expect(packageRelevance({ title: 'Crash', labels: ['pkg: babel-core'] }, tokens)).toBe('match')
    expect(packageRelevance({ title: 'Crash', labels: ['pkg: babel-parser'] }, tokens)).toBe(
      'other',
    )
    expect(packageRelevance({ title: 'babel-core-js thing', labels: ['bug'] }, tokens)).toBe(
      'neutral',
    )
  })
})

describe('indexIssues over REST', () => {
  test('keeps bug-labelled and popular issues, skips pull requests, stores the cursor', async () => {
    const store = libraries()
    await store.putLibrary(library())
    const { client, calls } = fakeGitHub({
      rest: (path) =>
        path.includes('page=2')
          ? { data: [rest(4, { reactions: { total_count: 9 } }), rest(5)] }
          : {
              data: [
                rest(1, { labels: [{ name: 'bug' }], body: '<!-- t -->Crash' }),
                rest(2, { pull_request: {}, labels: ['bug'] }),
                rest(3, { labels: ['bug'], state_reason: 'duplicate' }),
              ],
              next: 'https://api.github.com/repos/acme/left-pad/issues?page=2',
            },
    })
    const result = await indexIssues({ store, github: client, library: library(), now })
    expect(result).toMatchObject({ status: 'ok', stored: 2, scanned: 5 })
    expect(calls.rest[0]).toBe(
      '/repos/acme/left-pad/issues?state=closed&sort=updated&direction=asc&per_page=100&since=2024-10-01T00%3A00%3A00.000Z',
    )
    expect(calls.graphql).toHaveLength(0)
    const one = await store.getIssue('github.com/acme/left-pad#1')
    expect(one).toMatchObject({
      ecosystem: 'npm',
      name: 'left-pad',
      body: 'Crash',
      labels: ['bug'],
    })
    expect(await store.getIssue('github.com/acme/left-pad#2')).toBeUndefined()
    expect(await store.getIssue('github.com/acme/left-pad#4')).toBeDefined()
    const saved = await store.getLibrary(library())
    expect(saved?.sources.issues).toEqual({ status: 'ok', at: now.toISOString() })
    expect(JSON.parse(saved?.issuesCursor ?? '{}')).toEqual({ issues: '2026-06-05T00:00:00Z' })
  })

  test('resumes from the cursor with a small overlap, never before the window', async () => {
    const store = libraries()
    await store.putLibrary(
      library({ issuesCursor: JSON.stringify({ issues: '2026-06-05T00:00:00Z' }) }),
    )
    const { client, calls } = fakeGitHub({ rest: () => ({ data: [] }) })
    await indexIssues({ store, github: client, library: library(), now })
    expect(calls.rest[0]).toContain(`since=${encodeURIComponent('2026-06-04T23:59:00.000Z')}`)
    const saved = await store.getLibrary(library())
    expect(JSON.parse(saved?.issuesCursor ?? '{}')).toEqual({ issues: '2026-06-05T00:00:00Z' })
  })

  test('drops issues created before the window', async () => {
    const store = libraries()
    const { client } = fakeGitHub({
      rest: () => ({ data: [rest(1, { labels: ['bug'], created_at: '2025-01-01T00:00:00Z' })] }),
    })
    const result = await indexIssues({
      store,
      github: client,
      library: library(),
      oldestUsedReleaseAt: '2026-01-01T00:00:00Z',
      now,
    })
    expect(result.stored).toBe(0)
  })

  test('marks partial runs when the page budget ends first', async () => {
    const store = libraries()
    const { client } = fakeGitHub({
      rest: () => ({ data: [rest(1, { labels: ['bug'] })], next: 'https://api.github.com/next' }),
    })
    const result = await indexIssues({
      store,
      github: client,
      library: library(),
      now,
      maxPages: 2,
    })
    expect(result).toMatchObject({
      status: 'ok',
      scanned: 2,
      message: 'partial: continues on the next run',
    })
  })

  test('caps stored threads with maxIssues', async () => {
    const store = libraries()
    const { client } = fakeGitHub({
      rest: () => ({ data: [1, 2, 3].map((n) => rest(n, { labels: ['bug'] })) }),
    })
    const result = await indexIssues({
      store,
      github: client,
      library: library(),
      now,
      maxIssues: 2,
    })
    expect(result.stored).toBe(2)
  })

  test('records a rate limit as failed and keeps the old cursor', async () => {
    const store = libraries()
    const cursor = JSON.stringify({ issues: '2026-06-05T00:00:00Z' })
    await store.putLibrary(library({ issuesCursor: cursor }))
    const client = fakeGitHub({}).client
    client.rest = () => Promise.reject(new GitHubRateLimitError(new Date('2026-10-01T01:00:00Z')))
    const result = await indexIssues({ store, github: client, library: library(), now })
    expect(result.status).toBe('failed')
    const saved = await store.getLibrary(library())
    expect(saved?.sources.issues?.status).toBe('failed')
    expect(saved?.sources.issues?.message).toContain('rate limit')
    expect(saved?.issuesCursor).toBe(cursor)
  })

  test('skips repositories outside GitHub', async () => {
    const store = libraries()
    const gitlab = library({
      repository: { host: 'gitlab.com', path: 'acme/x', url: 'https://gitlab.com/acme/x' },
    })
    const { client, calls } = fakeGitHub({})
    const result = await indexIssues({ store, github: client, library: gitlab, now })
    expect(result.status).toBe('skipped')
    expect(calls.rest).toHaveLength(0)
    expect((await store.getLibrary(gitlab))?.sources.issues?.status).toBe('skipped')
  })

  test('monorepos prefer threads about the package and drop other packages', async () => {
    const store = libraries()
    const babel = library({
      name: '@babel/core',
      repository: {
        host: 'github.com',
        path: 'babel/babel',
        directory: 'packages/babel-core',
        url: 'https://github.com/babel/babel',
      },
    })
    const { client } = fakeGitHub({
      rest: () => ({
        data: [
          rest(1, { labels: ['bug'], title: 'Generic crash' }),
          rest(2, { labels: ['bug', 'pkg: babel-parser'] }),
          rest(3, { labels: ['bug', 'pkg: babel-core'] }),
        ],
      }),
    })
    const result = await indexIssues({ store, github: client, library: babel, now, maxIssues: 1 })
    expect(result.stored).toBe(1)
    expect(await store.getIssue('github.com/babel/babel#3')).toBeDefined()
    const all = await indexIssues({ store, github: client, library: babel, now })
    expect(all.stored).toBe(2)
    expect(await store.getIssue('github.com/babel/babel#2')).toBeUndefined()
  })
})

describe('indexIssues over GraphQL', () => {
  test('reads pull requests, maintainer answers, fixedIn and answered discussions', async () => {
    const store = libraries()
    const { client, calls } = fakeGitHub({
      authenticated: true,
      graphql: (query, variables) => {
        if (query.includes('discussions('))
          return page('discussions', [
            {
              number: 20,
              title: 'How to pad emoji?',
              url: 'https://github.com/acme/left-pad/discussions/20',
              closed: false,
              body: 'Question',
              createdAt: '2026-07-01T00:00:00Z',
              updatedAt: '2026-08-01T00:00:00Z',
              labels: { nodes: [] },
              reactions: { totalCount: 1 },
              comments: { totalCount: 2 },
              answer: { body: 'Use graphemes; fixed in v1.5.0' },
            },
            {
              number: 19,
              title: 'Old',
              url: 'u',
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2024-01-01T00:00:00Z',
              answer: { body: 'old' },
            },
          ])
        if (variables.after === null)
          return page(
            'issues',
            [
              graphIssue(1, {
                closedByPullRequestsReferences: {
                  nodes: [{ number: 7, merged: true, milestone: { title: 'v1.3.0' } }],
                },
                comments: {
                  totalCount: 2,
                  nodes: [
                    { authorAssociation: 'NONE', body: 'me too' },
                    { authorAssociation: 'MEMBER', body: 'Fixed by #7' },
                  ],
                },
              }),
              graphIssue(2, {
                timelineItems: {
                  nodes: [
                    {
                      source: {
                        number: 8,
                        merged: true,
                        repository: { nameWithOwner: 'acme/left-pad' },
                      },
                    },
                    {
                      source: {
                        number: 9,
                        merged: true,
                        repository: { nameWithOwner: 'other/fork' },
                      },
                    },
                  ],
                },
                comments: {
                  totalCount: 1,
                  nodes: [{ authorAssociation: 'OWNER', body: 'Released in 1.4.2' }],
                },
              }),
            ],
            'c1',
          )
        return page('issues', [
          graphIssue(3),
          graphIssue(4, { stateReason: 'DUPLICATE', labels: { nodes: [{ name: 'bug' }] } }),
        ])
      },
    })
    const result = await indexIssues({ store, github: client, library: library(), now })
    expect(result).toMatchObject({ status: 'ok', stored: 3, scanned: 5 })
    expect(calls.rest).toHaveLength(0)
    expect(calls.graphql[1]?.variables).toMatchObject({
      owner: 'acme',
      name: 'left-pad',
      after: 'c1',
    })
    expect(await store.getIssue('github.com/acme/left-pad#1')).toMatchObject({
      pulls: [7],
      fixedIn: '1.3.0',
      answer: 'Fixed by #7',
    })
    expect(await store.getIssue('github.com/acme/left-pad#2')).toMatchObject({
      pulls: [8],
      fixedIn: '1.4.2',
    })
    expect(await store.getIssue('github.com/acme/left-pad#3')).toBeUndefined()
    expect(await store.getIssue('github.com/acme/left-pad#20')).toMatchObject({
      kind: 'discussion',
      answer: 'Use graphemes; fixed in v1.5.0',
      fixedIn: '1.5.0',
    })
    const cursor = JSON.parse((await store.getLibrary(library()))?.issuesCursor ?? '{}')
    expect(cursor).toEqual({ issues: '2026-06-04T00:00:00Z', discussions: '2026-08-01T00:00:00Z' })
  })

  test('keeps a stored digest while the state holds', async () => {
    const store = libraries()
    await store.putIssues([
      {
        ecosystem: 'npm',
        name: 'left-pad',
        id: 'github.com/acme/left-pad#1',
        number: 1,
        kind: 'issue',
        title: 'Issue 1',
        state: 'closed',
        labels: ['bug'],
        url: '',
        body: '',
        pulls: [],
        reactions: 0,
        comments: 0,
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
        digest: { problem: 'p', symptoms: [], at: '2026-05-02T00:00:00Z' },
      },
    ])
    const { client } = fakeGitHub({
      authenticated: true,
      graphql: (query) =>
        query.includes('discussions(')
          ? page('discussions', [])
          : page('issues', [graphIssue(1, { labels: { nodes: [{ name: 'bug' }] } })]),
    })
    await indexIssues({ store, github: client, library: library(), now })
    expect((await store.getIssue('github.com/acme/left-pad#1'))?.digest?.problem).toBe('p')
  })
})
