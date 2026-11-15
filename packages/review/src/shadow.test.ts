import { describe, expect, test } from 'bun:test'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { addedFile, fakeAgent, fakeForge } from '../test/fakes.ts'
import type { ReviewOptions } from './pipeline.ts'
import { requireReviewForge } from './pipeline.ts'
import type { ReviewData, ReviewFinding } from './schema.ts'
import { DEFAULT_IGNORE } from './scope.ts'
import { compareReviews, dryRunForge, shadowReview } from './shadow.ts'

const options: ReviewOptions = {
  mergeRequest: 7,
  mode: 'auto',
  maxComments: 15,
  minSeverity: 'minor',
  includeChecks: false,
  approve: 'never',
  ignore: [...DEFAULT_IGNORE],
  maxDiffLines: 3000,
  media: false,
}

const files = [
  {
    oldPath: 'src/price.ts',
    newPath: 'src/price.ts',
    status: 'added' as const,
    diff: addedFile(['export function price(a, b) {', '  return a * b', '}']),
  },
]

describe('dryRunForge', () => {
  test('reads pass through, the review and thread changes are collected', async () => {
    const fake = fakeForge({ files, discussions: [] })
    const { forge, wouldDo } = dryRunForge(requireReviewForge(fake.forge))
    expect((await forge.getMergeRequest('games/a', 7)).title).toBe('Add pricing')
    expect(forge.kind).toBe('gitlab')

    const outcome = await forge.submitReview('games/a', 7, {
      refs: { baseSha: 'b', startSha: 'b', headSha: 'h' },
      comments: [{ path: 'src/price.ts', line: 2, body: 'x' }],
      summary: 'Summary',
    })
    expect(outcome).toEqual({ posted: 1, failed: [] })
    await forge.replyToDiscussion?.('games/a', 7, 'd1', 'Reply')
    await forge.resolveDiscussion?.('games/a', 7, 'd1', true)

    expect(wouldDo.submissions).toHaveLength(1)
    expect(wouldDo.replies).toEqual([{ discussionId: 'd1', body: 'Reply' }])
    expect(wouldDo.resolved).toEqual(['d1'])
    expect(fake.submissions).toEqual([])
    expect(fake.replies).toEqual([])
    expect(fake.resolved).toEqual([])
  })

  test('any other method throws instead of changing the forge', async () => {
    const fake = fakeForge({ files, discussions: [] })
    const { forge } = dryRunForge(requireReviewForge(fake.forge))
    expect(() => forge.commentOnMergeRequest('games/a', 7, 'hi')).toThrow(/dry run/)
    expect(fake.notes).toEqual([])
  })
})

describe('shadowReview', () => {
  test('runs the review and reports what it would have posted without posting it', async () => {
    const fake = fakeForge({ files, discussions: [] })
    const { agent } = fakeAgent({
      review: [
        {
          comments: [
            {
              path: 'src/price.ts',
              line: 2,
              severity: 'major',
              category: 'bug',
              title: 'Rounding missing',
              body: 'Money must be rounded to cents.',
            },
          ],
          summary: 'One problem.',
          verdict: 'needs-changes',
        },
      ],
    })
    const { data, wouldDo } = await shadowReview({
      repo: { forge: 'work', path: 'games/a' },
      forge: requireReviewForge(fake.forge),
      runner: createFakeRunner().runner,
      dir: '/nonexistent-checkout',
      agent,
      options,
    })
    expect(data.comments.map((comment) => comment.title)).toEqual(['Rounding missing'])
    expect(data.comments[0]?.posted).toBe(true)
    expect(wouldDo.submissions).toHaveLength(1)
    expect(wouldDo.submissions[0]?.comments).toHaveLength(1)
    expect(fake.submissions).toEqual([])
  })
})

const finding = (overrides: Partial<ReviewFinding>): ReviewFinding => ({
  id: 'f',
  path: 'src/shape.ts',
  line: 10,
  severity: 'major',
  category: 'bug',
  title: 'Off by one',
  body: 'The loop skips the last item.',
  source: 'agent',
  posted: true,
  ...overrides,
})

const data = (comments: ReviewFinding[], extra: Partial<ReviewData> = {}): ReviewData => ({
  mergeRequest: {
    id: 7,
    title: 'Add shapes',
    webUrl: 'https://gitlab.test/g/p/-/merge_requests/7',
    sourceBranch: 'feat/shapes',
    targetBranch: 'main',
    author: 'jane',
  },
  head: 'a'.repeat(40),
  mode: 'full',
  verdict: 'needs-changes',
  summary: '',
  comments,
  threads: [],
  skipped: [],
  stats: {
    files: 1,
    changedLines: 3,
    dropped: { belowSeverity: 0, overLimit: 0, duplicates: 0, invalid: 0 },
  },
  approved: false,
  checks: [],
  ...extra,
})

describe('compareReviews', () => {
  test('pairs findings on the same problem and lists what only one run found', () => {
    const shared = finding({ id: 'a1' })
    const comparison = compareReviews(
      data([
        shared,
        finding({ id: 'a2', path: 'src/other.ts', title: 'Leak', body: 'Handle stays open.' }),
      ]),
      data([
        finding({
          id: 'b1',
          line: 11,
          title: 'Loop off by one',
          body: 'The loop skips the last item.',
        }),
        finding({
          id: 'b2',
          path: 'src/third.ts',
          category: 'security',
          title: 'Injection',
          body: 'Unescaped input.',
        }),
      ]),
    )
    expect(comparison.both.map(({ a, b }) => [a.id, b.id])).toEqual([['a1', 'b1']])
    expect(comparison.onlyA.map((f) => f.id)).toEqual(['a2'])
    expect(comparison.onlyB.map((f) => f.id)).toEqual(['b2'])
  })

  test('pairs one to one and ignores rejected comments', () => {
    const comparison = compareReviews(
      data([finding({ id: 'a1' }), finding({ id: 'a2' })]),
      data([
        finding({ id: 'b1' }),
        finding({ id: 'b2', posted: false, error: 'line not in diff' }),
      ]),
    )
    expect(comparison.both).toHaveLength(1)
    expect(comparison.onlyA).toHaveLength(1)
    expect(comparison.onlyB).toHaveLength(0)
  })

  test('reports the verdicts and the cost and turn difference when both runs have them', () => {
    const comparison = compareReviews(
      data([], { verdict: 'looks-good', usage: { turns: 3, costUsd: 0.1 } }),
      data([], { usage: { turns: 7, costUsd: 0.35 } }),
    )
    expect(comparison.verdict).toEqual({ a: 'looks-good', b: 'needs-changes' })
    expect(comparison.costUsd).toBeCloseTo(0.25)
    expect(comparison.turns).toBe(4)
    expect(compareReviews(data([]), data([])).costUsd).toBeUndefined()
  })
})
