import { describe, expect, test } from 'bun:test'

import type { BranchRecord, GitForge, MergeRequestRecord } from '@holtkeeper/forge'

import { analyzeBranches, classifyBranches } from './analyze.ts'
import { branchesOptionsSchema, createBranchesAnalyzer } from './analyzer.ts'
import { branchesReport } from './report.ts'

const now = new Date('2026-10-30T00:00:00Z')
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString()

const branch = (name: string, input: Partial<BranchRecord> = {}): BranchRecord => ({
  name,
  sha: `sha-${name}`,
  committedAt: daysAgo(1),
  authorName: 'Ann',
  merged: false,
  protected: false,
  default: false,
  ...input,
})

const mr = (
  id: number,
  sourceBranch: string,
  input: Partial<MergeRequestRecord> = {},
): MergeRequestRecord => ({
  id,
  title: `MR ${id}`,
  description: '',
  sourceBranch,
  targetBranch: 'main',
  state: 'merged',
  draft: false,
  labels: [],
  author: 'ann',
  webUrl: `https://gitlab.example.com/g/a/-/merge_requests/${id}`,
  createdAt: daysAgo(10),
  updatedAt: daysAgo(5),
  ...input,
})

const branches = [
  branch('main', { default: true, protected: true, committedAt: daysAgo(400) }),
  branch('release/1.x', { protected: true, committedAt: daysAgo(300) }),
  branch('merged-ff', { merged: true, committedAt: daysAgo(20) }),
  branch('squashed', { committedAt: daysAgo(30) }),
  branch('squashed-then-pushed', { committedAt: daysAgo(2) }),
  branch('abandoned', { committedAt: daysAgo(40), authorName: 'Bob' }),
  branch('old-wip', { committedAt: daysAgo(200), authorName: 'Bob' }),
  branch('old-in-review', { committedAt: daysAgo(200) }),
  branch('fresh'),
  branch('keep/me', { committedAt: daysAgo(500) }),
]

const mergeRequests = [
  mr(1, 'squashed', { headSha: 'sha-squashed', mergedAt: daysAgo(29) }),
  mr(2, 'squashed-then-pushed', { headSha: 'older', mergedAt: daysAgo(3) }),
  mr(3, 'abandoned', { state: 'closed', closedAt: daysAgo(35) }),
  mr(4, 'old-in-review', { state: 'open' }),
  mr(5, 'abandoned', { state: 'merged', updatedAt: daysAgo(60), mergedAt: daysAgo(60) }),
]

describe('classifyBranches', () => {
  test('finds merged, closed and stale branches and skips what must stay', () => {
    const data = classifyBranches(branches, mergeRequests, {
      defaultBranch: 'main',
      staleDays: 90,
      ignore: ['keep/*'],
      now,
    })
    expect(data.candidates.map((c) => [c.name, c.reason, c.ageDays])).toEqual([
      ['squashed', 'merged', 30],
      ['merged-ff', 'merged', 20],
      ['abandoned', 'closed', 40],
      ['old-wip', 'stale', 200],
    ])
    expect(data.total).toBe(7)
    expect(data.open).toBe(1)
    expect(data.candidates[0]?.mergeRequest).toEqual({
      id: 1,
      state: 'merged',
      title: 'MR 1',
      author: 'ann',
      webUrl: 'https://gitlab.example.com/g/a/-/merge_requests/1',
    })
    expect(data.candidates[2]?.mergeRequest?.id).toBe(3)
  })

  test('judges protected branches only when asked', () => {
    const data = classifyBranches(branches, [], {
      defaultBranch: 'main',
      staleDays: 90,
      includeProtected: true,
      now,
    })
    expect(data.candidates.find((c) => c.name === 'release/1.x')).toMatchObject({
      reason: 'stale',
      protected: true,
    })
    expect(data.candidates.some((c) => c.name === 'main')).toBe(false)
  })
})

describe('analyzeBranches', () => {
  test('reads merge requests updated since the oldest branch commit', async () => {
    const queries: unknown[] = []
    const forge: Pick<GitForge, 'getRepository' | 'listBranches' | 'listMergeRequests'> = {
      getRepository: () => Promise.reject(new Error('not needed')),
      listBranches: async () => branches,
      listMergeRequests: async (_repo, query) => {
        queries.push(query)
        return mergeRequests
      },
    }
    const data = await analyzeBranches({ forge, repo: 'g/a', now, staleDays: 90 })
    expect(queries).toEqual([{ state: 'all', updatedAfter: daysAgo(500) }])
    expect(data.defaultBranch).toBe('main')
    expect(data.candidates).toHaveLength(5)
  })

  test('throws when the forge cannot list branches', () => {
    const forge = { getRepository: () => Promise.reject(new Error('unused')) }
    expect(analyzeBranches({ forge, repo: 'g/a', now, staleDays: 90 })).rejects.toThrow(
      'this forge cannot list the branches of g/a',
    )
  })
})

describe('branches analyzer', () => {
  test('declares its needs and parses comma-separated ignores', async () => {
    const analyzer = createBranchesAnalyzer({ now: () => now })
    expect(analyzer.needs).toEqual({ forge: true })
    const options = branchesOptionsSchema.parse({ ignore: 'release/*, keep/*' })
    expect(options).toEqual({
      staleDays: 90,
      ignore: ['release/*', 'keep/*'],
      includeProtected: false,
    })
    const forge = {
      listBranches: async () => branches,
    } as unknown as GitForge
    const runner = {
      run: () => Promise.reject(new Error('the branches analyzer runs no commands')),
    }
    const { data } = await analyzer.run({
      repo: { forge: 'gitlab', path: 'g/a' },
      forge,
      runner,
      options,
    })
    expect(data.candidates.map((c) => c.name)).toEqual(['merged-ff', 'old-in-review', 'old-wip'])
  })
})

describe('branchesReport', () => {
  test('reports counts, branches, authors and changes', () => {
    const data = classifyBranches(branches, mergeRequests, {
      defaultBranch: 'main',
      staleDays: 90,
      now,
    })
    const previous = {
      ...data,
      candidates: [...data.candidates.slice(1), { ...data.candidates[0]!, name: 'gone' }],
    }
    const report = branchesReport(data, { previous, compareTo: 'last week' })
    expect(report.metrics.map((m) => [m.id, m.value, m.delta, m.tone])).toEqual([
      ['cleanup', 5, 0, 'warning'],
      ['merged', 2, 0, 'warning'],
      ['closed', 1, 0, 'warning'],
      ['stale', 2, 0, undefined],
      ['branches', 8, 0, undefined],
    ])
    expect(report.sections.map((s) => s.id)).toEqual(['cleanup', 'authors', 'changes'])
    const authors = report.sections[1]?.blocks[0]
    expect(authors?.type === 'table' ? authors.rows : []).toEqual([
      { author: 'Ann', total: 3, merged: 2, closed: 0, stale: 1, oldest: 500 },
      { author: 'Bob', total: 2, merged: 0, closed: 1, stale: 1, oldest: 200 },
    ])
    const changes = report.sections[2]?.blocks[0]
    expect(changes?.type === 'table' ? changes.rows.map((row) => row['branch']) : []).toEqual([
      'gone',
      'squashed',
    ])
  })

  test('says so when nothing needs cleaning up', () => {
    const data = classifyBranches([branch('main', { default: true })], [], {
      defaultBranch: 'main',
      staleDays: 90,
      now,
    })
    const report = branchesReport(data)
    expect(report.sections.map((s) => s.id)).toEqual(['cleanup'])
    expect(report.metrics[0]).toMatchObject({ value: 0 })
  })
})
