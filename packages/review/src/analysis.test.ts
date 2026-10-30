import { describe, expect, test } from 'bun:test'

import { createFakeRunner } from '@holtkeeper/exec/testing'
import { memoryStore } from '@holtkeeper/store/memory'

import { HEAD, addedFile, fakeAgent, fakeForge } from '../test/fakes.ts'
import { reviewAnalysis } from './analysis.ts'
import { createReviewAnalyzer, reviewOptionsSchema } from './analyzer.ts'
import type { ReviewData } from './schema.ts'

const repo = { forge: 'work', path: 'games/a' }

const data = (extra: Partial<ReviewData> = {}): ReviewData => ({
  mergeRequest: {
    id: 7,
    title: 'Add pricing',
    webUrl: 'https://x/7',
    sourceBranch: 'f',
    targetBranch: 'main',
    author: 'jane',
  },
  head: HEAD,
  mode: 'full',
  verdict: 'needs-changes',
  summary: 'Summary text.',
  comments: [
    {
      id: 'a',
      path: 'src/p.ts',
      line: 3,
      startLine: 2,
      severity: 'major',
      category: 'bug',
      title: 'Rounding',
      body: 'Round money.',
      source: 'agent',
      suggestion: { replacement: 'x\ny', original: 'a\nb' },
      posted: true,
    },
    {
      id: 'b',
      path: 'src/p.ts',
      line: 9,
      severity: 'minor',
      category: 'style',
      title: 'Rejected',
      body: 'b',
      source: 'oxlint',
      posted: false,
      error: 'bad line',
    },
  ],
  threads: [{ discussionId: 'd', action: 'resolved', path: 'src/p.ts', line: 1, reason: 'fixed' }],
  skipped: [{ path: 'bun.lock', reason: 'ignored' }],
  stats: {
    files: 1,
    changedLines: 10,
    dropped: { belowSeverity: 2, overLimit: 0, duplicates: 1, invalid: 0 },
  },
  approved: false,
  checks: [{ name: 'lint', ok: false, error: 'boom' }],
  usage: { turns: 4, costUsd: 0.12 },
  ...extra,
})

const record = (d: ReviewData, createdAt = '2026-10-30T00:00:00Z') => ({
  id: createdAt,
  repo,
  kind: 'review',
  ref: '!7',
  createdAt,
  data: d,
})

describe('reviewAnalysis', () => {
  test('validates its data', () => {
    expect(reviewAnalysis.schema.safeParse(data()).success).toBe(true)
  })

  test('report has the sections, non-applicable suggestions and comparisons', () => {
    const previous = data({ comments: [{ ...data().comments[0]!, id: 'old', title: 'Old' }] })
    const report = reviewAnalysis.toReport(record(data()), record(previous, '2026-10-29T00:00:00Z'))
    expect(report.sections.map((s) => s.id)).toEqual([
      'summary',
      'findings',
      'suggestions',
      'threads',
      'not-reviewed',
    ])
    const changes = report.sections[2]?.blocks[0]
    expect(changes?.type === 'changes' && changes.applicable).toBe(false)
    expect(changes?.type === 'changes' && changes.items[0]?.diff[0]?.hunks[0]?.newStart).toBe(2)
    const issues = report.sections[1]?.blocks.find(
      (b) => b.type === 'issues' && b.title === 'Comments',
    )
    expect(issues?.type === 'issues' && issues.items.map((i) => i.tags)).toEqual([
      ['major', 'bug', 'agent', 'suggestion', 'new'],
      ['minor', 'style', 'oxlint', 'rejected'],
    ])
    const gone = report.sections[1]?.blocks.find(
      (b) => b.type === 'issues' && b.title === 'No longer reported',
    )
    expect(gone?.type === 'issues' && gone.items.map((i) => i.id)).toEqual(['old'])
    const notReviewed = report.sections[4]?.blocks[0]
    expect(notReviewed?.type === 'table' && notReviewed.rows.length).toBe(4)
    expect(report.metrics.find((m) => m.id === 'comments')).toMatchObject({ value: 1, delta: 0 })
    expect(report.metrics.find((m) => m.id === 'cost')?.value).toBe('$0.12')
  })

  test('does not compare with another merge request', () => {
    const other = data({ mergeRequest: { ...data().mergeRequest, id: 8 } })
    const report = reviewAnalysis.toReport(record(data()), record(other))
    expect(report.subject?.compareTo).toBeUndefined()
    expect(report.metrics.find((m) => m.id === 'comments')?.delta).toBeUndefined()
  })
})

describe('review analyzer', () => {
  test('options: defaults and string forms from commands', () => {
    const parsed = reviewOptionsSchema.parse({
      mergeRequest: '7',
      includeChecks: 'lint,secrets',
      media: 'false',
    })
    expect(parsed).toMatchObject({
      mergeRequest: 7,
      mode: 'auto',
      maxComments: 15,
      minSeverity: 'minor',
      approve: 'never',
      includeChecks: ['lint', 'secrets'],
      media: false,
    })
    expect(parsed.ignore).toContain('**/*.lock')
    expect(
      reviewOptionsSchema.parse({ mergeRequest: 1, includeChecks: 'true' }).includeChecks,
    ).toBe(true)
    expect(reviewOptionsSchema.safeParse({}).success).toBe(false)
  })

  test('runs the review and stores it under !<iid>', async () => {
    const store = memoryStore()
    const { forge, submissions } = fakeForge({
      files: [{ oldPath: 'a.ts', newPath: 'a.ts', status: 'added', diff: addedFile(['x']) }],
      discussions: [],
    })
    const analyzer = createReviewAnalyzer({ instructionsFor: () => 'Team rule.' })
    const { agent, tasks } = fakeAgent({
      review: [{ comments: [], summary: 'Fine.', verdict: 'looks-good' }],
    })
    const result = await analyzer.run({
      repo,
      dir: '/nonexistent',
      forge,
      agent,
      runner: createFakeRunner(() => ({ stdout: `${HEAD}\n` })).runner,
      history: { analyses: store.analyses, auditRuns: store.auditRuns },
      options: reviewOptionsSchema.parse({ mergeRequest: 7 }),
    })
    expect(result.ref).toBe('!7')
    expect(result.data.verdict).toBe('looks-good')
    expect(tasks[0]?.context).toContain('Team rule.')
    expect(submissions).toHaveLength(1)
  })

  test('replyTo answers the thread instead of reviewing', async () => {
    const { forge, replies, submissions } = fakeForge({
      files: [],
      discussions: [
        {
          id: 'd1',
          resolvable: true,
          resolved: false,
          notes: [
            {
              id: 1,
              author: 'bot',
              body: 'x <!-- holtkeeper:review id=f -->',
              createdAt: '',
              system: false,
            },
            { id: 2, author: 'jane', body: 'why?', createdAt: '', system: false },
          ],
        },
      ],
    })
    const { agent } = fakeAgent({
      review: [{ action: 'explain', body: 'Because.', resolve: false }],
    })
    const result = await createReviewAnalyzer().run({
      repo,
      forge,
      agent,
      runner: createFakeRunner().runner,
      options: reviewOptionsSchema.parse({ mergeRequest: 7, replyTo: 'd1' }),
    })
    expect(result.data.mode).toBe('reply')
    expect(result.data.threads).toEqual([
      { discussionId: 'd1', action: 'replied', reason: 'explain' },
    ])
    expect(replies).toHaveLength(1)
    expect(submissions).toEqual([])
  })
})
