import type { LibraryIssue, LibraryRecord } from '@holtkeeper/store'

import type { GitHubClient } from '../github/client.ts'

/** A scripted `GitHubClient` for tests: handlers answer by path or query, every call is recorded. */
export function fakeGitHub(options: {
  authenticated?: boolean
  rest?: (path: string) => { data: unknown; next?: string } | undefined
  graphql?: (query: string, variables: Record<string, unknown>) => unknown
}) {
  const calls: {
    rest: string[]
    graphql: { query: string; variables: Record<string, unknown> }[]
  } = {
    rest: [],
    graphql: [],
  }
  const client: GitHubClient = {
    authenticated: options.authenticated ?? false,
    // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- matches the generic contract
    async rest<T>(path: string) {
      calls.rest.push(path)
      const answer = options.rest?.(path)
      if (!answer) return { status: 404, data: undefined }
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests script the shape
      return { status: 200, data: answer.data as T, ...(answer.next ? { next: answer.next } : {}) }
    },
    async bytes() {
      return undefined
    },
    async graphql<T>(query: string, variables: Record<string, unknown> = {}) {
      calls.graphql.push({ query, variables })
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests script the shape
      return options.graphql?.(query, variables) as T
    },
  }
  return { client, calls }
}

export const library = (overrides: Partial<LibraryRecord> = {}): LibraryRecord => ({
  ecosystem: 'npm',
  name: 'left-pad',
  repository: {
    host: 'github.com',
    path: 'acme/left-pad',
    url: 'https://github.com/acme/left-pad',
  },
  sources: {},
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

export const storedIssue = (overrides: Partial<LibraryIssue> = {}): LibraryIssue => ({
  ecosystem: 'npm',
  name: 'left-pad',
  id: 'github.com/acme/left-pad#1',
  number: 1,
  kind: 'issue',
  title: 'Crash on empty string',
  state: 'closed',
  labels: ['bug'],
  url: 'https://github.com/acme/left-pad/issues/1',
  body: 'TypeError: Cannot read properties of undefined',
  pulls: [2],
  reactions: 3,
  comments: 1,
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-02T00:00:00.000Z',
  closedAt: '2026-03-02T00:00:00.000Z',
  ...overrides,
})
