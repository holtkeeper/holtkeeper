import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'
import type { Discussion } from '@holtkeeper/forge'
import type { QualityCheck } from '@holtkeeper/quality'
import { memoryStore } from '@holtkeeper/store/memory'

import { HEAD, addedFile, fakeAgent, fakeForge } from '../test/fakes.ts'
import { findingMarker, openThreads } from './dedupe.ts'
import { summaryMarker } from './format.ts'
import type { MediaReviewer } from './media.ts'
import {
  type ReviewOptions,
  type ReviewRun,
  requireReviewForge,
  reviewMergeRequest,
  summaryThreads,
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

const finding = (line: number, source: string) => ({
  path: 'src/price.ts',
  line,
  severity: 'minor' as const,
  category: 'tests' as const,
  title: `${source}: rule`,
  body: `found on ${line}`,
  source,
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
      runOf({
        forge: requireReviewForge(forge),
        agent,
        guide: async (docs) => ({
          text: `Guide with ${docs.length} docs. Check money.`,
          scopes: ['all', 'group:web'],
        }),
      }),
    )

    expect(tasks[0]?.taskKind).toBe('review')
    expect(tasks[0]?.tier).toBe('main')
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
    expect(data.usage).toMatchObject({ turns: 2, inputTokens: 100, model: 'fake-main' })
    expect(data.guideScopes).toEqual(['all', 'group:web'])
    expect(data.durationMs).toBeGreaterThanOrEqual(0)

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
      const data = await reviewMergeRequest(
        runOf({
          forge: requireReviewForge(forge),
          agent,
          dir,
          guide: async () => ({ text: 'Plain rules.', scopes: [] }),
        }),
      )
      expect(tasks[0]?.context).toContain('Plain rules.')
      expect(data.guideScopes).toBeUndefined()

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

  test('the prompt sends dependency questions to the package tools, not node_modules', async () => {
    const { forge } = fakeForge({ files, discussions: [] })
    const { agent, tasks } = fakeAgent({ review: [review([])] })
    await reviewMergeRequest(runOf({ forge: requireReviewForge(forge), agent }))
    expect(tasks[0]?.system).toContain('node_modules or the module cache may be missing')
    expect(tasks[0]?.system).toContain('Packages defined in this checkout: read their source here')
    expect(tasks[0]?.system).toContain('search_symbols by export name')
  })

  describe('modern Go guidelines', () => {
    const goFiles = [
      {
        oldPath: 'cmd/shapes/main.go',
        newPath: 'cmd/shapes/main.go',
        status: 'added' as const,
        diff: addedFile(['package main', '', 'func main() {}']),
      },
    ]
    const goSet = {
      tag: 'v9.9.9',
      source: 'github' as const,
      guidelines: [
        {
          id: 'shape_range',
          since_version: '1.22',
          guideline: 'Range over an integer count.',
          details: 'Shorter.',
          examples: [{ before: ['for i := 0; i < n; i++ {}'], after: ['for i := range n {}'] }],
        },
        {
          id: 'shape_future',
          since_version: '1.40',
          guideline: 'Use the future form.',
          details: 'Newer.',
          examples: [{ before: ['old()'], after: ['fresh()'] }],
        },
      ],
    }

    const runGo = async (
      diffFiles: typeof files,
      goGuidelines: ReviewOptions['goGuidelines'] = { enabled: true },
    ) => {
      const dir = await mkdtemp(join(tmpdir(), 'review-go-'))
      try {
        await writeFile(join(dir, 'go.mod'), 'module example.com/acme/shapes\n\ngo 1.23\n')
        const { forge } = fakeForge({ files: diffFiles, discussions: [] })
        const { agent, tasks } = fakeAgent({ review: [review([])] })
        const pins: (string | undefined)[] = []
        await reviewMergeRequest(
          runOf({
            forge: requireReviewForge(forge),
            agent,
            dir,
            options: { ...options, goGuidelines },
            goGuidelines: async (tag) => {
              pins.push(tag)
              return goSet
            },
          }),
        )
        return { task: tasks[0], pins }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }

    test('adds the guidelines for the module go version when Go files change', async () => {
      const { task, pins } = await runGo(goFiles, { enabled: true, tag: 'v9.9.9' })
      expect(pins).toEqual(['v9.9.9'])
      expect(task?.prompt).toContain('Modern Go guidelines: third-party reference data')
      expect(task?.prompt).toContain('`.` go 1.23 (1 changed file)')
      expect(task?.prompt).toContain('[Go 1.22+] shape_range')
      expect(task?.prompt).not.toContain('shape_future')
      expect(task?.system).toContain('the go.mod of the module owning the file')
      expect(task?.system).not.toContain('package.json')
    })

    test('leaves the prompt unchanged without Go files or when turned off', async () => {
      const npm = await runGo(files)
      expect(npm.pins).toEqual([])
      expect(npm.task?.prompt).not.toContain('Modern Go guidelines')
      expect(npm.task?.system).toContain('from package.json, the lockfile or repo_packages')

      const off = await runGo(goFiles, { enabled: false })
      expect(off.pins).toEqual([])
      expect(off.task?.prompt).not.toContain('Modern Go guidelines')
    })
  })

  test('a deep review runs on the deep model tier', async () => {
    const { forge } = fakeForge({ files, discussions: [] })
    const { agent, tasks } = fakeAgent({ review: [review([], 'looks-good')] })
    await reviewMergeRequest(
      runOf({
        forge: requireReviewForge(forge),
        agent,
        options: { ...options, depth: 'deep' },
      }),
    )
    expect(tasks[0]?.tier).toBe('deep')
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
    const secrets: QualityCheck = {
      name: 'secrets',
      detect: async () => true,
      run: async () => ({
        issues: [
          {
            id: 'i',
            tool: 'gitleaks',
            rule: 'generic-api-key',
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
        checks: { secrets },
        options: {
          ...options,
          includeChecks: ['secrets'],
          minSeverity: 'info',
          approve: 'when-clean',
        },
      }),
    )
    expect(data.comments.map((c) => c.source)).toEqual(['gitleaks'])
    expect(data.checks).toEqual([{ name: 'secrets', ok: true }])
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
        webUrl: 'https://forge.example.com/acme/widget/-/merge_requests/7',
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
    expect(tasks[1]?.tier).toBe('fast')
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

  test('hands testids findings to the agent, which keeps the ones it comments on', async () => {
    let requested: number[] = []
    const { forge } = fakeForge({ files, discussions: [] })
    const data = await reviewMergeRequest(
      runOf({
        forge: requireReviewForge(forge),
        agent: {} as never,
        steps: {
          deterministic: async () => ({
            candidates: [finding(1, 'testids'), finding(3, 'testids'), finding(4, 'oxlint')],
            checks: [],
          }),
          agentReview: async (_run, _loaded, _plan, _usage, requests) => {
            requested = (requests ?? []).map((r) => r.line)
            return {
              candidates: [
                {
                  ...finding(1, 'agent'),
                  suggestion: { replacement: 'export function price(a, b) { // data-test' },
                },
              ],
              summary: 's',
              verdict: 'looks-good',
            }
          },
        },
      }),
    )
    expect(requested).toEqual([1, 3])
    expect(
      data.comments.map((c) => [c.source, c.line]).toSorted((a, b) => Number(a[1]) - Number(b[1])),
    ).toEqual([
      ['agent', 1],
      ['oxlint', 4],
    ])
  })

  test('without tests by design the prompt skips tests and agent test findings are dropped', async () => {
    const { forge } = fakeForge({ files, discussions: [] })
    const { agent, tasks } = fakeAgent({
      review: [
        review([
          { ...finding(2, 'agent'), severity: 'major', title: 'Add a test', body: 'x' },
          { ...finding(1, 'agent'), severity: 'major', category: 'bug', body: 'y' },
        ]),
      ],
    })
    const data = await reviewMergeRequest(
      runOf({ forge: requireReviewForge(forge), agent, tests: false }),
    )
    expect(tasks[0]?.system).not.toContain('missing tests')
    expect(tasks[0]?.system).toContain(
      'Categories: bug, security, performance, maintainability, style, docs.',
    )
    expect(tasks[0]?.system).toContain('surrounding code and callers instead')
    expect(data.comments.map((c) => [c.line, c.category])).toEqual([[1, 'bug']])
  })

  test('without tests by design the flagged test-id lines still get their comments', async () => {
    const { forge } = fakeForge({ files, discussions: [] })
    const { agent, tasks } = fakeAgent({
      review: [
        review([
          {
            ...finding(1, 'agent'),
            suggestion: { replacement: 'export function price(a, b) { // data-test' },
          },
          { ...finding(2, 'agent'), title: 'Add a test' },
        ]),
      ],
    })
    const data = await reviewMergeRequest(
      runOf({
        forge: requireReviewForge(forge),
        agent,
        tests: false,
        steps: {
          deterministic: async () => ({ candidates: [finding(1, 'testids')], checks: [] }),
        },
      }),
    )
    expect(tasks[0]?.system).not.toContain('missing tests')
    expect(tasks[0]?.system).toContain('Use `tests` only for the lines the checks flagged with it.')
    expect(tasks[0]?.system).toMatch(/Categories: [^\n]*\btests\b/)
    expect(data.comments.map((c) => [c.line, c.category])).toEqual([[1, 'tests']])
  })

  test('requireReviewForge names missing methods', () => {
    expect(() => requireReviewForge({ kind: 'x' } as never)).toThrow('getMergeRequest')
  })
})

const summaryThread = (id: string, author: string, extra: Partial<Discussion> = {}) => ({
  id,
  resolvable: true,
  resolved: false,
  notes: [
    {
      id,
      author,
      body: `### Holtkeeper review: Needs changes\n\nOlder run.\n\n${summaryMarker('o'.repeat(40))}`,
      createdAt: '',
      system: false,
    },
  ],
  ...extra,
})
const earlier = (): Discussion[] => [
  summaryThread('old-summary', 'holtkeeper'),
  summaryThread('done-summary', 'holtkeeper', { resolved: true }),
  summaryThread('quoted-summary', 'jane'),
  summaryThread('inline-summary', 'holtkeeper', {
    position: { path: 'src/price.ts', line: 2, side: 'new', headSha: HEAD },
  }),
  {
    id: 'finding',
    resolvable: true,
    resolved: false,
    notes: [
      {
        id: 'finding',
        author: 'holtkeeper',
        body: `Widget leaks.\n\n${findingMarker('f-1')}`,
        createdAt: '',
        system: false,
      },
    ],
    position: { path: 'src/price.ts', line: 2, side: 'new', headSha: HEAD },
  },
]

const setup = (
  verdict?: AgentReview['verdict'],
  resolveSummary?: ReviewOptions['resolveSummary'],
) => {
  const fake = fakeForge({ files, discussions: earlier(), summaryAuthor: 'holtkeeper' })
  const lines: string[] = []
  const run = runOf({
    forge: requireReviewForge(fake.forge),
    botUsername: 'holtkeeper',
    log: (line) => lines.push(line),
    ...(verdict ? { agent: fakeAgent({ review: [review([], verdict)] }).agent } : {}),
    ...(resolveSummary ? { options: { ...options, resolveSummary } } : {}),
  })
  return { ...fake, run, lines }
}

describe('summary threads', () => {
  test('a clean run resolves its own summary and earlier ones of our account', async () => {
    const { run, resolved, submissions } = setup('looks-good')
    const data = await reviewMergeRequest(run)
    expect(data.verdict).toBe('looks-good')
    expect(submissions).toHaveLength(1)
    expect(resolved).toEqual(['old-summary', 'summary-1'])
  })

  test('summary threads are not finding threads', () => {
    expect(openThreads(earlier(), 'holtkeeper').map((t) => t.discussionId)).toEqual([
      'inline-summary',
      'finding',
    ])
    expect(summaryThreads(earlier(), 'holtkeeper')).toEqual(['old-summary'])
    expect(summaryThreads(earlier(), 'jane')).toEqual(['quoted-summary'])
  })

  test('a needs-changes run resolves nothing', async () => {
    const { run, resolved } = setup('needs-changes')
    expect((await reviewMergeRequest(run)).verdict).toBe('needs-changes')
    expect(resolved).toEqual([])
  })

  test('never resolves nothing, always resolves after needs-changes too', async () => {
    const never = setup('looks-good', 'never')
    await reviewMergeRequest(never.run)
    expect(never.resolved).toEqual([])

    const always = setup('needs-changes', 'always')
    await reviewMergeRequest(always.run)
    expect(always.resolved).toEqual(['old-summary', 'summary-1'])
  })

  test('a forge without resolveDiscussion skips quietly', async () => {
    const { forge, submissions } = fakeForge({ files, discussions: earlier() })
    const listed: number[] = []
    const bare = {
      ...forge,
      resolveDiscussion: undefined,
      listDiscussions: async () => {
        listed.push(1)
        return earlier()
      },
    }
    const data = await reviewMergeRequest(runOf({ forge: requireReviewForge(bare) }))
    expect(data.verdict).toBe('looks-good')
    expect(submissions).toHaveLength(1)
    expect(listed).toEqual([1])
  })

  test('a failing resolve does not fail the review', async () => {
    const { run, lines } = setup()
    const failing = {
      ...run.forge,
      resolveDiscussion: async (_repo: string, _id: number, discussionId: string) => {
        if (discussionId === 'old-summary') throw new Error('comments are off')
      },
    }
    const data = await reviewMergeRequest({ ...run, forge: failing })
    expect(data.verdict).toBe('looks-good')
    expect(lines).toContain('resolving summary thread old-summary failed: comments are off')
    expect(lines).toContain('resolved summary thread summary-1')
  })

  test('without any known account nothing is resolved', async () => {
    const { forge, resolved } = fakeForge({
      files,
      discussions: earlier(),
      summaryAuthor: 'holtkeeper',
    })
    const lines: string[] = []
    await reviewMergeRequest(
      runOf({ forge: requireReviewForge(forge), log: (line) => lines.push(line) }),
    )
    expect(resolved).toEqual([])
    expect(lines).toContain('resolving summary threads skipped: the forge account is unknown')
  })

  test('the token account wins over a stale bot username', async () => {
    const { forge, resolved } = fakeForge({
      files,
      discussions: earlier(),
      summaryAuthor: 'holtkeeper',
    })
    const withUser = {
      ...forge,
      getCurrentUser: async () => ({ username: 'holtkeeper', name: 'H' }),
    }
    await reviewMergeRequest(runOf({ forge: requireReviewForge(withUser), botUsername: 'jane' }))
    expect(resolved).toEqual(['old-summary', 'summary-1'])
  })

  test('without a bot username the token account decides what is ours', async () => {
    const { forge, resolved } = fakeForge({
      files,
      discussions: earlier(),
      summaryAuthor: 'holtkeeper',
    })
    const withUser = {
      ...forge,
      getCurrentUser: async () => ({ username: 'HoltKeeper', name: 'H' }),
    }
    await reviewMergeRequest(runOf({ forge: requireReviewForge(withUser) }))
    expect(resolved).toEqual(['old-summary', 'summary-1'])
  })
})
