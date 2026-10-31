import { describe, expect, test } from 'bun:test'

import type {
  BranchRecord,
  Discussion,
  GitForge,
  MergeRequestRecord,
  Pipeline,
  TagRecord,
} from '@holtkeeper/forge'

import { type RepoCursor, pollRepository } from './poll.ts'
import { pollEventKinds } from './setting.ts'

const repo = { forge: 'work', path: 'games/app' }

const mr = (patch: Partial<MergeRequestRecord> = {}): MergeRequestRecord => ({
  id: 7,
  title: 'Add board',
  description: '',
  sourceBranch: 'board',
  targetBranch: 'main',
  state: 'open',
  draft: false,
  labels: [],
  author: 'dev',
  webUrl: 'https://gitlab.test/games/app/-/merge_requests/7',
  createdAt: '2026-10-30T10:00:00Z',
  updatedAt: '2026-10-30T10:00:00Z',
  headSha: 'a'.repeat(40),
  ...patch,
})

function fakeForge(state: {
  mergeRequests: MergeRequestRecord[]
  discussions?: Discussion[]
  pipelines?: Pipeline[]
  tags?: TagRecord[]
}) {
  const calls: string[] = []
  const forge = {
    kind: 'gitlab',
    listMergeRequests: async (_repo: string, query: unknown) => {
      calls.push(`mrs ${JSON.stringify(query)}`)
      return state.mergeRequests
    },
    listDiscussions: async () => {
      calls.push('discussions')
      return state.discussions ?? []
    },
    listPipelines: async () => {
      calls.push('pipelines')
      return state.pipelines ?? []
    },
    listTags: async () => {
      calls.push('tags')
      return state.tags ?? []
    },
  } as unknown as GitForge
  return { forge, calls }
}

const branch = (name: string, sha: string, committedAt: string): BranchRecord => ({
  name,
  sha,
  committedAt,
  merged: false,
  protected: false,
  default: name === 'main',
})

const poll = (forge: GitForge, cursor: RepoCursor | undefined, at: string) =>
  pollRepository({ forge, repo, cursor, now: new Date(at), events: pollEventKinds })

describe('pollRepository', () => {
  test('the first poll records the state and reports nothing', async () => {
    const { forge, calls } = fakeForge({
      mergeRequests: [mr()],
      tags: [{ name: 'v1.0.0', sha: 'b'.repeat(40), committedAt: '2026-10-01T00:00:00Z' }],
      pipelines: [{ id: 1, ref: 'main', sha: 'a'.repeat(40), status: 'success', webUrl: '' }],
    })
    const result = await poll(forge, undefined, '2026-10-30T11:00:00Z')
    expect(result.events).toEqual([])
    expect(result.cursor.mergeRequests['7']?.headSha).toBe('a'.repeat(40))
    expect(result.cursor.tags).toEqual({ 'v1.0.0': 'b'.repeat(40) })
    expect(result.cursor.pipelines).toEqual([1])
    expect(calls).toEqual(['mrs {"state":"open","limit":100}', 'pipelines', 'tags'])
    expect(result.requests).toBe(3)
  })

  test('reports new commits, added labels, comments, finished pipelines and tags once', async () => {
    const state = { mergeRequests: [mr()] } as Parameters<typeof fakeForge>[0]
    const { forge } = fakeForge(state)
    const first = await poll(forge, undefined, '2026-10-30T11:00:00Z')

    state.mergeRequests = [
      mr({ updatedAt: '2026-10-30T11:03:00Z', headSha: 'c'.repeat(40), labels: ['needs-port'] }),
    ]
    state.discussions = [
      {
        id: 'd1',
        resolvable: false,
        resolved: false,
        notes: [
          {
            id: 1,
            author: 'dev',
            body: '/holtkeeper review',
            createdAt: '2026-10-30T11:02:00Z',
            system: false,
          },
        ],
      },
    ]
    state.pipelines = [{ id: 2, ref: 'board', sha: 'c'.repeat(40), status: 'failed', webUrl: '' }]
    state.tags = [{ name: 'v1.1.0', sha: 'd'.repeat(40), committedAt: '2026-10-30T11:01:00Z' }]

    const second = await poll(forge, first.cursor, '2026-10-30T11:05:00Z')
    expect(second.events.map((event) => event.kind)).toEqual([
      'mergeRequest',
      'note',
      'pipeline',
      'tag',
    ])
    expect(second.events[0]).toMatchObject({
      action: 'update',
      newCommits: true,
      labelsAdded: ['needs-port'],
      mr: { id: 7, headSha: 'c'.repeat(40) },
    })
    expect(second.events[1]).toMatchObject({
      mergeRequest: 7,
      body: '/holtkeeper review',
      discussionId: 'd1',
      inThread: false,
    })
    expect(second.events[2]).toMatchObject({ mergeRequest: 7, pipelineId: 2, status: 'failed' })
    expect(second.events[3]).toMatchObject({ tag: 'v1.1.0' })

    const third = await poll(forge, second.cursor, '2026-10-30T11:06:00Z')
    expect(third.events).toEqual([])
  })

  test('reports opened, merged and reopened merge requests', async () => {
    const state = { mergeRequests: [] as MergeRequestRecord[] }
    const { forge } = fakeForge(state)
    const first = await poll(forge, undefined, '2026-10-30T11:00:00Z')

    state.mergeRequests = [
      mr({ createdAt: '2026-10-30T11:01:00Z', updatedAt: '2026-10-30T11:01:00Z' }),
    ]
    const opened = await poll(forge, first.cursor, '2026-10-30T11:02:00Z')
    expect(opened.events).toMatchObject([{ kind: 'mergeRequest', action: 'open' }])

    state.mergeRequests = [mr({ state: 'merged', updatedAt: '2026-10-30T11:03:00Z' })]
    const merged = await poll(forge, opened.cursor, '2026-10-30T11:04:00Z')
    expect(merged.events).toMatchObject([{ kind: 'mergeRequest', action: 'merge' }])
  })

  test('skips what the forge cannot list and what is not asked for', async () => {
    const forge = {
      kind: 'other',
      listPipelines: async () => [],
    } as unknown as GitForge
    const result = await pollRepository({
      forge,
      repo,
      cursor: undefined,
      now: new Date('2026-10-30T11:00:00Z'),
      events: ['tags'],
    })
    expect(result).toMatchObject({ events: [], requests: 0 })
  })

  test('reports branches that moved or appeared since the previous poll', async () => {
    let branches = [branch('main', 'a'.repeat(40), '2026-10-30T09:00:00Z')]
    const forge = { kind: 'gitlab', listBranches: async () => branches } as unknown as GitForge
    const pushes = (cursor: RepoCursor | undefined, at: string) =>
      pollRepository({ forge, repo, cursor, now: new Date(at), events: ['pushes'] })

    const first = await pushes(undefined, '2026-10-30T11:00:00Z')
    expect(first.events).toEqual([])
    expect(first.cursor.branches).toEqual({ main: 'a'.repeat(40) })

    branches = [
      branch('feature', 'c'.repeat(40), '2026-10-30T11:02:00Z'),
      branch('main', 'b'.repeat(40), '2026-10-30T11:01:00Z'),
    ]
    const second = await pushes(first.cursor, '2026-10-30T11:05:00Z')
    expect(second.events).toEqual([
      { kind: 'push', repo, branch: 'main', sha: 'b'.repeat(40), actor: '' },
      { kind: 'push', repo, branch: 'feature', sha: 'c'.repeat(40), actor: '' },
    ])
    expect((await pushes(second.cursor, '2026-10-30T11:10:00Z')).events).toEqual([])

    const { branches: _, ...older } = second.cursor
    expect((await pushes(older, '2026-10-30T11:15:00Z')).events).toEqual([])
  })
})
