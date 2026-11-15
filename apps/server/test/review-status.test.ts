import { beforeEach, describe, expect, test } from 'bun:test'

import { parseConfig } from '@holtkeeper/core'
import type { Discussion, MergeRequest } from '@holtkeeper/forge'
import { type ReviewData, commentBody } from '@holtkeeper/review'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'

import { reviewToolsAccess } from '../src/review-status.ts'
import { reviewsToolset } from '../src/tools/reviews.ts'

const mr: MergeRequest & { headSha: string } = {
  id: 7,
  title: 'Round the widget corners',
  description: '',
  sourceBranch: 'feature/round-widgets',
  targetBranch: 'main',
  state: 'open',
  draft: false,
  labels: [],
  author: 'jane',
  webUrl: 'https://forge.test/shapes/widget/-/merge_requests/7',
  headSha: 'bbbbbbbb1111',
}

const finding = {
  id: 'f1',
  path: 'src/widget.ts',
  line: 12,
  severity: 'major' as const,
  category: 'bug' as const,
  title: 'Radius can be negative',
  body: 'A negative radius renders nothing; clamp it to zero.',
  source: 'agent',
  posted: true,
}

let discussions: Discussion[]

const forge = {
  findMergeRequest: async (_repo: string, query: { sourceBranch: string }) =>
    query.sourceBranch === mr.sourceBranch ? mr : undefined,
  getMergeRequest: async (_repo: string, id: number) => {
    if (id !== mr.id) throw new Error('not found')
    return mr
  },
  listDiscussions: async () => discussions,
}

const config = (onMergeRequest?: object) =>
  parseConfig({
    forges: { work: { kind: 'gitlab', url: 'https://forge.test', create: () => forge as never } },
    teams: { shapes: { owns: ['work:shapes/*'] }, colors: { owns: ['work:colors/*'] } },
    ...(onMergeRequest && { jobs: { onMergeRequest } }),
  })

const review = (fields: Partial<ReviewData>): ReviewData => ({
  mergeRequest: {
    id: mr.id,
    title: mr.title,
    webUrl: mr.webUrl,
    sourceBranch: mr.sourceBranch,
    targetBranch: mr.targetBranch,
    author: mr.author,
  },
  head: 'aaaaaaaa0000',
  mode: 'full',
  verdict: 'needs-changes',
  summary: 'One bug in the radius handling.',
  comments: [finding],
  threads: [],
  skipped: [],
  stats: {
    files: 1,
    changedLines: 20,
    dropped: { belowSeverity: 0, overLimit: 0, duplicates: 0, invalid: 0 },
  },
  approved: false,
  checks: [],
  ...fields,
})

const repo = { forge: 'work', path: 'shapes/widget' }
let store: Store

const addReview = (createdAt: string, data: ReviewData) =>
  store.analyses.add({ repo, kind: 'review', ref: `!${mr.id}`, createdAt, data })

const statusText = async (
  args: Record<string, unknown>,
  options: { onMergeRequest?: object; canRead?: boolean } = {},
) => {
  const access = reviewToolsAccess(
    { store, config: config(options.onMergeRequest) },
    (target) => (options.canRead ?? true) && target.teams.includes('shapes'),
  )
  const [tool] = reviewsToolset(access).tools
  return tool!.run(args, { dir: '.', signal: new AbortController().signal })
}

beforeEach(() => {
  store = memoryStore()
  discussions = []
})

describe('review_status', () => {
  test('finds the merge request by branch and lists findings, open threads and what to do', async () => {
    await addReview('2026-11-10T10:00:00.000Z', review({}))
    discussions = [
      {
        id: 'd1',
        resolvable: true,
        resolved: false,
        notes: [
          {
            id: 1,
            author: 'holtkeeper',
            body: commentBody(finding),
            createdAt: '2026-11-10T10:00:00.000Z',
            system: false,
          },
          {
            id: 2,
            author: 'jane',
            body: 'Why zero?',
            createdAt: '2026-11-10T11:00:00.000Z',
            system: false,
          },
        ],
      },
      { id: 'd2', resolvable: true, resolved: false, notes: [] },
    ]
    const text = await statusText(
      { repo: 'work:shapes/widget', branch: 'feature/round-widgets' },
      { onMergeRequest: { analyzers: ['review'] } },
    )
    expect(text).toContain('## work:shapes/widget!7 Round the widget corners')
    expect(text).toContain(
      '**Review: Needs changes** (full, 2026-11-10T10:00:00.000Z, reviewed aaaaaaaa, older than the head)',
    )
    expect(text).toContain('- **major** · bug · `src/widget.ts:12` — **Radius can be negative**')
    expect(text).toContain('### Open Holtkeeper threads (1)')
    expect(text).toContain('Radius can be negative (1 reply)')
    expect(text).toContain('no review is queued for them; comment `/holtkeeper review`')
    expect(text).toContain('Fix the open threads')
  })

  test('reports a running review, earlier runs and resolved threads after fixes', async () => {
    await addReview('2026-11-10T10:00:00.000Z', review({}))
    await addReview(
      '2026-11-10T12:00:00.000Z',
      review({
        head: mr.headSha,
        mode: 'incremental',
        verdict: 'looks-good',
        comments: [],
        threads: [
          {
            discussionId: 'd1',
            action: 'resolved',
            path: 'src/widget.ts',
            line: 12,
            reason: 'Clamped now.',
          },
        ],
      }),
    )
    await store.jobs.enqueue({
      analyzer: 'review',
      repo,
      ref: 'cccccccc2222',
      options: { mergeRequest: mr.id },
      trigger: 'webhook',
      createdAt: '2026-11-10T13:00:00.000Z',
    })
    const text = await statusText({ repo: 'work:shapes/widget', mergeRequest: 7 })
    expect(text).toContain('**Review: Looks good** (incremental')
    expect(text).toContain('- Resolved · `src/widget.ts:12`: Clamped now.')
    expect(text).toContain('### Open Holtkeeper threads (0)')
    expect(text).toContain('Needs changes · 1 findings, 0 threads resolved')
    expect(text).toContain('A review is queued for cccccccc')
  })

  test('says how to ask for a review when none runs by itself', async () => {
    const text = await statusText({ repo: 'work:shapes/widget', branch: 'feature/round-widgets' })
    expect(text).toContain('**Review:** none yet')
    expect(text).toContain(
      'No review yet: merge requests are not reviewed automatically; comment `/holtkeeper review`',
    )
  })

  test('refuses unreadable repositories, unknown branches and missing arguments', async () => {
    expect(statusText({ repo: 'work:colors/red', branch: 'x' })).rejects.toThrow(
      'No repository work:colors/red you may read reviews of',
    )
    expect(
      statusText({ repo: 'work:shapes/widget', branch: 'x' }, { canRead: false }),
    ).rejects.toThrow('you may read reviews of')
    expect(statusText({ repo: 'work:shapes/widget', branch: 'feature/none' })).rejects.toThrow(
      'No merge request from branch feature/none',
    )
    expect(statusText({ repo: 'work:shapes/widget' })).rejects.toThrow(
      'Pass branch or mergeRequest.',
    )
  })
})
