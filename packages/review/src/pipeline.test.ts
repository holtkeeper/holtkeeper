import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'
import type { Discussion } from '@holtkeeper/forge'
import type { QualityCheck } from '@holtkeeper/quality'
import { memoryStore } from '@holtkeeper/store/memory'

import { HEAD, addedFile, fakeAgent, fakeForge } from '../test/fakes.ts'
import { findingMarker } from './dedupe.ts'
import type { MediaReviewer } from './media.ts'
import {
  type ReviewOptions,
  type ReviewRun,
  requireReviewForge,
  reviewMergeRequest,
} from './pipeline.ts'
import type { AgentReview, ReviewData } from './schema.ts'
import { DEFAULT_IGNORE } from './scope.ts'

const repo = { forge: 'work', path: 'games/a' }
const options: ReviewOptions = {
  mergeRequest: 7,
  mode: 'auto',
  maxComments: 15,
  minSeverity: 'minor',
  includeChecks: false,
  approve: 'never',
  ignore: [...DEFAULT_IGNORE],
  maxDiffLines: 3000,
  media: true,
}

const priceLines = [
  'export function price(a, b) {',
  '  return a * b',
  '}',
  'export const tax = 0.2',
]
const files = [
  {
    oldPath: 'src/price.ts',
    newPath: 'src/price.ts',
    status: 'added' as const,
    diff: addedFile(priceLines),
  },
  { oldPath: 'bun.lock', newPath: 'bun.lock', status: 'modified' as const, diff: addedFile(['x']) },
]

const review = (
  comments: AgentReview['comments'],
  verdict: AgentReview['verdict'] = 'needs-changes',
): AgentReview => ({
  comments,
  summary: 'Pricing looks mostly fine.',
  verdict,
})

const runOf = (extra: Partial<ReviewRun> & Pick<ReviewRun, 'forge'>): ReviewRun => ({
  repo,
  runner: createFakeRunner().runner,
  options,
  dir: '/nonexistent-checkout',
  ...extra,
})

describe('reviewMergeRequest', () => {
  test('posts validated, ranked comments with a summary', async () => {
    const { forge, submissions } = fakeForge({ files, discussions: [] })
    const { agent, tasks } = fakeAgent({
      review: [
        review([
          {
            path: 'src/price.ts',
            line: 2,
            severity: 'major',
            category: 'bug',
            title: 'Rounding missing',
            body: 'Money must be rounded to cents.',
            suggestion: { replacement: '  return Math.round(a * b * 100) / 100' },
          },
          {
            path: 'src/price.ts',
            line: 40,
            severity: 'minor',
            category: 'style',
            title: 'Far away',
            body: 'x',
          },
          {
            path: 'src/price.ts',
            line: 4,
            severity: 'info',
            category: 'docs',
            title: 'Doc',
            body: 'Document tax.',
          },
          {
            path: 'bun.lock',
            line: 1,
            severity: 'major',
            category: 'bug',
            title: 'Lock',
            body: 'x',
          },
        ]),
      ],
    })
    const data = await reviewMergeRequest(
      runOf({ forge: requireReviewForge(forge), agent, instructions: 'Check money.' }),
    )

    expect(tasks[0]?.taskKind).toBe('review')
    expect(tasks[0]?.context).toContain('Check money.')
    expect(tasks[0]?.prompt).toContain('2 +   return a * b')
    expect(tasks[0]?.prompt).not.toContain('bun.lock')

    expect(data.mode).toBe('full')
    expect(data.verdict).toBe('needs-changes')
    expect(data.comments.map((c) => [c.line, c.severity])).toEqual([[2, 'major']])
    expect(data.comments[0]?.suggestion).toEqual({
      replacement: '  return Math.round(a * b * 100) / 100',
      original: '  return a * b',
    })
    expect(data.stats.dropped).toEqual({
      belowSeverity: 1,
      overLimit: 0,
      duplicates: 0,
      invalid: 2,
    })
    expect(data.skipped).toEqual([{ path: 'bun.lock', reason: 'ignored' }])
    expect(data.usage).toMatchObject({ turns: 2, inputTokens: 100 })

    const [submission] = submissions
    expect(submission?.event).toBe('comment')
    expect(submission?.comments).toHaveLength(1)
    expect(submission?.comments[0]).toMatchObject({ path: 'src/price.ts', line: 2, side: 'new' })
    expect(submission?.comments[0]?.body).toContain(findingMarker(data.comments[0]?.id ?? ''))
    expect(submission?.summary).toContain('| Major | 1 |')
    expect(submission?.summary).toContain('bun.lock')
  })

  test('applies REVIEW.md path rules and posts the walkthrough and effort', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-paths-'))
    try {
      await writeFile(
        join(dir, 'REVIEW.md'),
        '## Paths\n\n- `src/**`: money is integer cents.\n- `migrations/**`: reversible only.\n',
      )
      const { forge, submissions } = fakeForge({ files, discussions: [] })
      const { agent, tasks } = fakeAgent({
        review: [
          {
            ...review([], 'looks-good'),
            walkthrough: [{ files: ['src/price.ts'], change: 'Adds price | tax helpers.' }],
            effort: 2,
          },
        ],
      })
      const data = await reviewMergeRequest(runOf({ forge: requireReviewForge(forge), agent, dir }))

      expect(tasks[0]?.prompt).toContain('- `src/**` (src/price.ts): money is integer cents.')
      expect(tasks[0]?.prompt).not.toContain('reversible only')
      expect(data.walkthrough).toEqual([
        { files: ['src/price.ts'], change: 'Adds price | tax helpers.' },
      ])
      expect(data.effort).toBe(2)
      expect(submissions[0]?.summary).toContain('Review effort: 2/5.')
      expect(submissions[0]?.summary).toContain('| `src/price.ts` | Adds price \\| tax helpers. |')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('marks comments the forge rejected', async () => {
    const { forge } = fakeForge({ files, discussions: [], reject: () => 'line outside the diff' })
    const { agent } = fakeAgent({
      review: [
        review([
          {
            path: 'src/price.ts',
            line: 1,
            severity: 'minor',
            category: 'bug',
            title: 't',
            body: 'b',
          },
        ]),
      ],
    })
    const data = await reviewMergeRequest(runOf({ forge: requireReviewForge(forge), agent }))
    expect(data.comments[0]).toMatchObject({ posted: false, error: 'line outside the diff' })
  })

  test('without an agent posts deterministic findings and approves when clean', async () => {
    const lint: QualityCheck = {
      name: 'lint',
      detect: async () => true,
      run: async () => ({
        issues: [
          {
            id: 'i',
            tool: 'oxlint',
            rule: 'no-console',
            category: 'lint',
            severity: 'info',
            message: 'console',
            file: 'src/price.ts',
            range: { start: { line: 4, column: 1 }, end: { line: 4, column: 5 } },
          },
        ],
      }),
    }
    const { forge, submissions } = fakeForge({ files, discussions: [] })
    const data = await reviewMergeRequest(
      runOf({
        forge: requireReviewForge(forge),
        checks: { lint },
        options: {
          ...options,
          includeChecks: ['lint'],
          minSeverity: 'info',
          approve: 'when-clean',
        },
      }),
    )
    expect(data.comments.map((c) => c.source)).toEqual(['oxlint'])
    expect(data.checks).toEqual([{ name: 'lint', ok: true }])
    expect(data.approved).toBe(true)
    expect(submissions[0]?.event).toBe('approve')
  })

  test('skips merge requests over maxDiffLines once', async () => {
    const store = memoryStore()
    const { forge, submissions } = fakeForge({ files, discussions: [] })
    const run = runOf({
      forge: requireReviewForge(forge),
      analyses: store.analyses,
      options: { ...options, maxDiffLines: 2 },
    })
    const data = await reviewMergeRequest(run)
    expect(data.mode).toBe('skipped')
    expect(data.skipped).toContainEqual({ path: 'src/price.ts', reason: 'too-large' })
    expect(submissions[0]?.summary).toContain('more than the limit of 2')
    await store.analyses.add({
      repo,
      kind: 'review',
      ref: '!7',
      createdAt: '2026-10-30T00:00:00Z',
      data,
    })
    await reviewMergeRequest(run)
    expect(submissions).toHaveLength(1)
  })

  test('incremental: reviews new lines only, resolves fixed threads and replies to repeats', async () => {
    const store = memoryStore()
    const previousHead = 'p'.repeat(40)
    const previous: ReviewData = {
      mergeRequest: {
        id: 7,
        title: 't',
        webUrl: 'w',
        sourceBranch: 's',
        targetBranch: 'main',
        author: 'jane',
      },
      head: previousHead,
      mode: 'full',
      verdict: 'needs-changes',
      summary: '',
      comments: [],
      threads: [],
      skipped: [],
      stats: {
        files: 1,
        changedLines: 4,
        dropped: { belowSeverity: 0, overLimit: 0, duplicates: 0, invalid: 0 },
      },
      approved: false,
      checks: [],
    }
    await store.analyses.add({
      repo,
      kind: 'review',
      ref: '!7',
      createdAt: '2026-10-29T00:00:00Z',
      data: previous,
    })
    const thread = (id: string, path: string, line: number, body: string): Discussion => ({
      id,
      resolvable: true,
      resolved: false,
      notes: [
        {
          id,
          author: 'bot',
          body: `${body}\n\n${findingMarker(id)}`,
          createdAt: '',
          system: false,
        },
      ],
      position: { path, line, side: 'new', headSha: previousHead },
    })
    const discussions = [
      thread('fixed', 'src/price.ts', 2, 'Rounding missing: money must be rounded to cents.'),
      thread(
        'repeat',
        'src/price.ts',
        4,
        'Tax rate is hard-coded; read it from the config instead.',
      ),
      thread('gone', 'src/removed.ts', 1, 'Old problem'),
    ]
    const { forge, submissions, replies, resolved, compared } = fakeForge({
      files,
      discussions,
      compare: [
        {
          oldPath: 'src/price.ts',
          newPath: 'src/price.ts',
          status: 'modified',
          diff: '@@ -3,1 +3,2 @@\n }\n+export const tax = 0.2\n',
        },
      ],
    })
    const { agent, tasks } = fakeAgent({
      review: [
        review(
          [
            {
              path: 'src/price.ts',
              line: 4,
              severity: 'minor',
              category: 'maintainability',
              title: 'Hard-coded tax rate',
              body: 'Tax rate is hard-coded; read it from the config.',
            },
            {
              path: 'src/price.ts',
              line: 2,
              severity: 'major',
              category: 'bug',
              title: 'Outside scope',
              body: 'x',
            },
          ],
          'looks-good',
        ),
      ],
      triage: [
        {
          threads: [
            { id: 'fixed', status: 'fixed', note: 'Rounding was added.' },
            { id: 'repeat', status: 'still-relevant', note: 'The rate is still a literal.' },
          ],
        },
      ],
    })
    const runner = createFakeRunner(() => ({ exitCode: 0 })).runner
    const data = await reviewMergeRequest(
      runOf({ forge: requireReviewForge(forge), agent, runner, analyses: store.analyses }),
    )

    expect(compared).toEqual([[previousHead, HEAD]])
    expect(data.mode).toBe('incremental')
    expect(data.previousHead).toBe(previousHead)
    expect(tasks[0]?.prompt).toContain('4 + export const tax = 0.2')
    expect(tasks[0]?.prompt).toContain('2 ~   return a * b')
    expect(tasks[1]?.taskKind).toBe('triage')
    expect(data.threads.map((t) => [t.discussionId, t.action])).toEqual([
      ['fixed', 'resolved'],
      ['repeat', 'replied'],
      ['gone', 'resolved'],
    ])
    expect(resolved).toEqual(['fixed', 'gone'])
    expect(replies.find((r) => r.discussionId === 'repeat')?.body).toContain('Still applies')
    // The repeat is answered in its thread; line 2 was reviewed before.
    expect(data.comments).toEqual([])
    expect(data.stats.dropped).toMatchObject({ duplicates: 1, invalid: 1 })
    expect(submissions[0]?.summary).toContain('2 resolved, 1 still relevant')
  })

  test('falls back to a full review after a force push', async () => {
    const store = memoryStore()
    await store.analyses.add({
      repo,
      kind: 'review',
      ref: '!7',
      createdAt: '2026-10-29T00:00:00Z',
      data: {
        ...(await reviewMergeRequest(
          runOf({ forge: requireReviewForge(fakeForge({ files, discussions: [] }).forge) }),
        )),
        head: 'old',
      },
    })
    const { forge, compared } = fakeForge({ files, discussions: [] })
    const runner = createFakeRunner(() => ({ exitCode: 1 })).runner
    const data = await reviewMergeRequest(
      runOf({ forge: requireReviewForge(forge), runner, analyses: store.analyses }),
    )
    expect(data.mode).toBe('full')
    expect(compared).toEqual([])
  })

  test('merges media findings and appends the images summary', async () => {
    const svg = {
      oldPath: 'logo.svg',
      newPath: 'logo.svg',
      status: 'added' as const,
      diff: addedFile(['<svg>', '<path d="M0 0"/>', '</svg>']),
    }
    const png = {
      oldPath: 'hero.png',
      newPath: 'hero.png',
      status: 'added' as const,
      diff: '',
      binary: true,
    }
    const usage = {
      oldPath: 'index.html',
      newPath: 'index.html',
      status: 'modified' as const,
      diff: '@@ -1 +1,2 @@\n <body>\n+<img src="hero.png">\n',
    }
    const { forge, submissions } = fakeForge({
      files: [svg, png, usage],
      discussions: [],
      contents: { 'logo.svg': '<svg>\n<path d="M0 0"/>\n</svg>' },
      bytes: { 'hero.png': new Uint8Array([1, 2, 3]) },
    })
    const seen: Parameters<MediaReviewer['review']>[0][] = []
    const mediaReviewer: MediaReviewer = {
      async review(input) {
        seen.push(input)
        return {
          comments: [
            {
              path: 'index.html',
              line: 2,
              body: 'Serve AVIF with <picture>\n\nSaves 80%.',
              suggestion: {
                replacement:
                  '<picture><source srcset="hero.avif" type="image/avif"><img src="hero.png"></picture>',
              },
            },
          ],
          summary: '| Image | Saved |\n| --- | --- |\n| hero.png | 80% |',
        }
      },
    }
    const data = await reviewMergeRequest(
      runOf({ forge: requireReviewForge(forge), mediaReviewer }),
    )
    expect(seen[0]?.files.map((f) => [f.path, f.text !== undefined, f.bytes?.length])).toEqual([
      ['logo.svg', true, undefined],
      ['hero.png', false, 3],
    ])
    expect(seen[0]?.usages).toEqual([{ path: 'index.html', line: 2, text: '<img src="hero.png">' }])
    expect(data.comments.map((c) => [c.source, c.severity, c.category, c.title])).toEqual([
      ['media', 'minor', 'performance', 'Serve AVIF with <picture>'],
    ])
    expect(data.comments[0]?.suggestion?.original).toBe('<img src="hero.png">')
    expect(data.summary).toContain('#### Images')
    expect(submissions[0]?.summary).toContain('hero.png | 80%')

    const off = fakeForge({ files: [svg, png, usage], discussions: [] })
    const quiet = await reviewMergeRequest(
      runOf({
        forge: requireReviewForge(off.forge),
        mediaReviewer,
        options: { ...options, media: false },
      }),
    )
    expect(quiet.comments).toEqual([])
    expect(seen).toHaveLength(1)
  })

  test('replaced steps are used', async () => {
    const { forge, submissions } = fakeForge({ files, discussions: [] })
    const data = await reviewMergeRequest(
      runOf({
        forge: requireReviewForge(forge),
        steps: {
          deterministic: async () => ({
            candidates: [
              {
                path: 'src/price.ts',
                line: 1,
                severity: 'critical',
                category: 'security',
                title: 'Custom',
                body: 'b',
                source: 'custom',
              },
            ],
            checks: [],
          }),
        },
      }),
    )
    expect(data.comments.map((c) => c.source)).toEqual(['custom'])
    expect(data.verdict).toBe('needs-changes')
    expect(submissions).toHaveLength(1)
  })

  test('requireReviewForge names missing methods', () => {
    expect(() => requireReviewForge({ kind: 'x' } as never)).toThrow('getMergeRequest')
  })
})
