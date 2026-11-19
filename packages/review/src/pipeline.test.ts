import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'
import type { DiffFile, Discussion } from '@holtkeeper/forge'
import type { QualityCheck } from '@holtkeeper/quality'
import { memoryStore } from '@holtkeeper/store/memory'

import { HEAD, addedFile, fakeAgent, fakeForge } from '../test/fakes.ts'
import { type OpenThread, findingMarker, openThreads } from './dedupe.ts'
import { summaryMarker } from './format.ts'
import type { MediaReviewer } from './media.ts'
import {
  type ReviewOptions,
  type ReviewRun,
  requireReviewForge,
  reviewMergeRequest,
  summaryThreads,
  threadsToRecheck,
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

const citedFinding = (line: number, severity: 'major' | 'minor', title: string) => ({
  path: 'src/price.ts',
  line,
  severity,
  category: 'bug' as const,
  title,
  body: 'b',
  evidence: [{ path: 'src/missing.ts', line: 3, note: 'made up' }],
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

const depManifest = (deps: Record<string, string>) =>
  JSON.stringify({ name: 'shapes-app', dependencies: deps })
const depLock = (deps: Record<string, string>, versions: Record<string, string>) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'shapes-app', dependencies: deps },
      ...Object.fromEntries(
        Object.entries(versions).map(([name, version]) => [`node_modules/${name}`, { version }]),
      ),
    },
  })

const runOf = (extra: Partial<ReviewRun> & Pick<ReviewRun, 'forge'>): ReviewRun => ({
  repo,
  runner: createFakeRunner().runner,
  options,
  dir: '/nonexistent-checkout',
  ...extra,
})

describe('reviewMergeRequest', () => {
  test('costLimitUsd gives the review and its verification their shares as soft limits', async () => {
    const { forge } = fakeForge({ files, discussions: [] })
    const { agent, tasks } = fakeAgent({
      review: [
        review([
          {
            path: 'src/price.ts',
            line: 2,
            severity: 'minor',
            category: 'bug',
            title: 'Rounding missing',
            body: 'Money must be rounded to cents.',
          },
        ]),
      ],
    })
    await reviewMergeRequest(
      runOf({
        forge: requireReviewForge(forge),
        agent,
        options: { ...options, costLimitUsd: 2 },
      }),
    )
    expect(tasks.map((task) => [task.taskKind, task.answerAtCostUsd])).toEqual([
      ['review', 2 * 0.6],
      ['review-verify', 2 * 0.25],
    ])
  })

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
    const stages: unknown[] = []
    const data = await reviewMergeRequest(
      runOf({
        forge: requireReviewForge(forge),
        agent,
        guide: async (repoFiles) => ({
          text: `Rules with ${repoFiles.length} files. Check money.`,
          sources: ['All repositories', 'Team web'],
        }),
        onProgress: (stage) => stages.push(stage),
      }),
    )
    expect(stages).toEqual([
      { stage: 'review', parts: 1, done: 0, deep: false },
      { stage: 'verify', findings: 1 },
      { stage: 'post' },
    ])

    expect(tasks[0]?.taskKind).toBe('review')
    expect(tasks[0]?.phase).toBe('initial')
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
    // The review and the verification of its one major finding, which answered nothing.
    expect(tasks[1]).toMatchObject({ taskKind: 'review-verify', tier: 'deep' })
    expect(tasks[1]?.prompt).toContain('Rounding missing')
    expect(data.usage).toMatchObject({ turns: 4, inputTokens: 200, model: 'fake-main' })
    expect(data.ruleSources).toEqual(['All repositories', 'Team web'])
    expect(data.durationMs).toBeGreaterThanOrEqual(0)

    const [submission] = submissions
    expect(submission?.event).toBe('comment')
    expect(submission?.comments).toHaveLength(1)
    expect(submission?.comments[0]).toMatchObject({ path: 'src/price.ts', line: 2, side: 'new' })
    expect(submission?.comments[0]?.body).toContain(findingMarker(data.comments[0]?.id ?? ''))
    expect(submission?.summary).toContain('| Major | 1 |')
    expect(submission?.summary).toContain('bun.lock')
    expect(submission?.summary).toContain('<sub>The review took ~1 min and cost $0.02.</sub>')
  })

  test('showCost false leaves the time and cost out of the summary', async () => {
    const { forge, submissions } = fakeForge({ files, discussions: [] })
    const { agent } = fakeAgent({ review: [review([])] })
    const data = await reviewMergeRequest(
      runOf({
        forge: requireReviewForge(forge),
        agent,
        options: { ...options, showCost: false },
      }),
    )
    expect(data.usage?.costUsd).toBeGreaterThan(0)
    expect(submissions[0]?.summary).not.toContain('The review took')
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
          guide: async () => ({ text: 'Plain rules.', sources: [] }),
        }),
      )
      expect(tasks[0]?.context).toContain('Plain rules.')
      expect(data.ruleSources).toBeUndefined()

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
      expect(npm.task?.system).toContain('from package.json, lockfiles.resolve or repo_packages')

      const off = await runGo(goFiles, { enabled: false })
      expect(off.pins).toEqual([])
      expect(off.task?.prompt).not.toContain('Modern Go guidelines')
    })
  })

  test('computes the dependency section from base and head when the lockfile diff is binary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-deps-'))
    try {
      await writeFile(join(dir, 'package.json'), depManifest({ 'color-kit': '^2.0.0' }))
      await writeFile(
        join(dir, 'package-lock.json'),
        depLock({ 'color-kit': '^2.0.0' }, { 'color-kit': '2.3.0' }),
      )
      const { forge } = fakeForge({
        files: [
          {
            oldPath: 'package.json',
            newPath: 'package.json',
            status: 'modified',
            diff: '@@ -1 +1 @@\n-{}\n+{"dependencies":{"color-kit":"^2.0.0"}}\n',
          },
          {
            oldPath: 'package-lock.json',
            newPath: 'package-lock.json',
            status: 'modified',
            diff: '',
            binary: true,
          },
        ],
        discussions: [],
        contents: { 'package.json': depManifest({}), 'package-lock.json': depLock({}, {}) },
      })
      const { agent, tasks } = fakeAgent({ review: [review([], 'looks-good')] })
      await reviewMergeRequest(runOf({ forge: requireReviewForge(forge), agent, dir }))
      const prompt = tasks[0]?.prompt ?? ''
      expect(prompt).toContain('## Dependency changes (computed from the lockfiles)')
      expect(prompt).toContain('added dependencies `color-kit` ^2.0.0, lockfile resolves 2.3.0')
      expect(prompt).toContain('Consistency: OK.')
      expect(prompt.indexOf('Consistency: OK.')).toBeLessThan(prompt.indexOf('Diff:'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
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

  test('drops findings the verification refutes and lets the rest decide the verdict', async () => {
    const { forge } = fakeForge({ files, discussions: [] })
    const { agent, tasks } = fakeAgent({
      review: [
        review(
          [
            citedFinding(2, 'major', 'Flag never reset'),
            citedFinding(3, 'minor', 'Tax not documented'),
          ],
          'needs-changes',
        ),
      ],
      'review-verify': [
        { findings: [{ id: 0, verdict: 'refuted', reason: 'Reset in src/price.ts:9.' }] },
        { findings: [{ id: 1, verdict: 'confirmed', reason: 'Holds.' }] },
      ],
      triage: [{ summary: 'Pricing is fine; the tax rule lacks docs.' }],
    })
    const data = await reviewMergeRequest(runOf({ forge: requireReviewForge(forge), agent }))
    expect(tasks.filter((t) => t.taskKind === 'review-verify').map((t) => t.tier)).toEqual([
      'deep',
      'main',
    ])
    expect(data.comments.map((c) => c.title)).toEqual(['Tax not documented'])
    // The cited file does not exist in the checkout, so the citation is dropped.
    expect(data.comments[0]?.evidence).toBeUndefined()
    expect(data.refuted).toEqual([
      {
        path: 'src/price.ts',
        line: 2,
        severity: 'major',
        title: 'Flag never reset',
        reason: 'Reset in src/price.ts:9.',
      },
    ])
    expect(data.stats.dropped.refuted).toBe(1)
    expect(data.verdict).toBe('looks-good')
    const revision = tasks.find((t) => t.taskKind === 'triage')
    expect(revision?.prompt).toContain('Flag never reset')
    expect(revision?.prompt).not.toContain('Tax not documented')
    expect(data.summary).toBe('Pricing is fine; the tax rule lacks docs.')
  })

  test('findings over the comment limit fill the places of refuted ones', async () => {
    const { forge } = fakeForge({ files, discussions: [] })
    const { agent } = fakeAgent({
      review: [
        review([
          citedFinding(1, 'major', 'Wrong total'),
          citedFinding(2, 'minor', 'Rounding off'),
          citedFinding(3, 'minor', 'Tax skipped'),
        ]),
      ],
      'review-verify': [
        { findings: [{ id: 0, verdict: 'refuted', reason: 'Checked in src/price.ts:9.' }] },
        {
          findings: [
            { id: 1, verdict: 'confirmed', reason: 'Holds.' },
            { id: 2, verdict: 'confirmed', reason: 'Holds.' },
          ],
        },
      ],
    })
    const data = await reviewMergeRequest(
      runOf({ forge: requireReviewForge(forge), agent, options: { ...options, maxComments: 1 } }),
    )
    expect(data.comments.map((c) => c.title)).toEqual(['Rounding off'])
    expect(data.stats.dropped).toMatchObject({ refuted: 1, overLimit: 1 })
  })

  test('verify: false posts the findings unchecked', async () => {
    const { forge } = fakeForge({ files, discussions: [] })
    const { agent, tasks } = fakeAgent({
      review: [
        review([
          {
            path: 'src/price.ts',
            line: 2,
            severity: 'major',
            category: 'bug',
            title: 't',
            body: 'b',
          },
        ]),
      ],
    })
    const data = await reviewMergeRequest(
      runOf({ forge: requireReviewForge(forge), agent, options: { ...options, verify: false } }),
    )
    expect(tasks.map((t) => t.taskKind)).toEqual(['review'])
    expect(data.comments).toHaveLength(1)
  })

  test('puts the computed public API changes before the diff', async () => {
    const { forge } = fakeForge({ files, discussions: [] })
    const { agent, tasks } = fakeAgent({ review: [review([], 'looks-good')] })
    const asked: { baseSha: string; files: readonly string[] }[] = []
    await reviewMergeRequest(
      runOf({
        forge: requireReviewForge(forge),
        agent,
        apiChanges: async ({ baseSha, files: changed }) => {
          asked.push({ baseSha, files: changed })
          return '## Public API changes (computed: base → head)\n\n- removed `makeWidget`'
        },
      }),
    )
    expect(asked).toEqual([{ baseSha: 'b'.repeat(40), files: ['src/price.ts'] }])
    const prompt = tasks[0]?.prompt ?? ''
    expect(prompt.indexOf('removed `makeWidget`')).toBeGreaterThan(-1)
    expect(prompt.indexOf('removed `makeWidget`')).toBeLessThan(prompt.indexOf('Diff:'))
  })

  test('the tickets the merge request names go into the prompt when they can be read', async () => {
    const { forge } = fakeForge({
      files,
      discussions: [],
      mergeRequest: {
        title: 'ABC-1: add pricing',
        sourceBranch: 'feature/def-2-pricing',
        description: 'See also XYZ-3.',
      },
    })
    const { agent, tasks } = fakeAgent({ review: [review([], 'looks-good')] })
    const asked: string[][] = []
    const lines: string[] = []
    await reviewMergeRequest(
      runOf({
        forge: requireReviewForge(forge),
        agent,
        tickets: async (keys) => {
          asked.push([...keys])
          return [{ key: 'DEF-2', title: 'Price widgets', description: 'Prices in cents.' }]
        },
        log: (line) => lines.push(line),
      }),
    )
    expect(asked).toEqual([['ABC-1', 'DEF-2']])
    expect(tasks[0]?.prompt).toContain('### DEF-2: Price widgets\n\nPrices in cents.')
    expect(lines).toContain('ticket context: DEF-2')
  })

  test('no readable ticket, no hook or a failing one leave tickets out of the prompt', async () => {
    const { forge } = fakeForge({ files, discussions: [], mergeRequest: { title: 'ABC-1: x' } })
    for (const tickets of [
      async () => [],
      async () => {
        throw new Error('tracker down')
      },
      undefined,
    ]) {
      const { agent, tasks } = fakeAgent({ review: [review([], 'looks-good')] })
      const lines: string[] = []
      // oxlint-disable-next-line no-await-in-loop -- one case after another
      await reviewMergeRequest(
        runOf({
          forge: requireReviewForge(forge),
          agent,
          ...(tickets && { tickets }),
          log: (line) => lines.push(line),
        }),
      )
      expect(tasks[0]?.prompt).not.toContain('issue tracker')
      expect(lines.some((line) => line.startsWith('ticket context'))).toBe(tickets !== undefined)
    }
  })

  test('without verification, unverified suspicions are dropped', async () => {
    const { forge } = fakeForge({ files, discussions: [] })
    const { agent } = fakeAgent({
      review: [
        review([
          {
            path: 'src/price.ts',
            line: 1,
            severity: 'major',
            category: 'bug',
            title: 'Maybe broken',
            body: 'b',
            unverified: true,
          },
        ]),
      ],
    })
    const data = await reviewMergeRequest(
      runOf({ forge: requireReviewForge(forge), agent, options: { ...options, verify: false } }),
    )
    expect(data.comments).toEqual([])
    expect(data.refuted?.[0]?.reason).toBe('Not confirmed: the review ran no verification.')
  })

  test('a failing API changes hook leaves the section out', async () => {
    const { forge } = fakeForge({ files, discussions: [] })
    const { agent, tasks } = fakeAgent({ review: [review([], 'looks-good')] })
    const data = await reviewMergeRequest(
      runOf({
        forge: requireReviewForge(forge),
        agent,
        apiChanges: async () => {
          throw new Error('worktree failed')
        },
      }),
    )
    expect(tasks[0]?.prompt).not.toContain('Public API changes')
    expect(data.verdict).toBe('looks-good')
  })

  test('auto depth reviews a small change on main and a large one on deep', async () => {
    const { forge } = fakeForge({ files, discussions: [] })
    const small = fakeAgent({ review: [review([], 'looks-good')] })
    await reviewMergeRequest(
      runOf({
        forge: requireReviewForge(forge),
        agent: small.agent,
        options: { ...options, depth: 'auto' },
      }),
    )
    expect(small.tasks[0]?.tier).toBe('main')
    const large = fakeAgent({ review: [review([], 'looks-good')] })
    await reviewMergeRequest(
      runOf({
        forge: requireReviewForge(forge),
        agent: large.agent,
        options: { ...options, depth: 'auto', deepFromMinutes: 1 },
      }),
    )
    expect(large.tasks[0]?.tier).toBe('deep')
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
    expect(tasks[0]?.phase).toBe('update')
    expect(tasks[1]?.taskKind).toBe('triage')
    expect(tasks[1]?.phase).toBe('recheck')
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
    expect(submissions[0]?.summary).toContain('2 resolved, 1 still open')
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

const splitAnswer = (texts: Record<string, string | undefined>) => ({
  splittable: true,
  reason: '',
  direction: 'Merge prices first, then gadgets.',
  texts,
})

describe('review size', () => {
  const twoFiles = [
    ...files,
    {
      oldPath: 'src/gadget.ts',
      newPath: 'src/gadget.ts',
      status: 'added' as const,
      diff: addedFile(['export const gadget = 1']),
    },
  ]
  const strict = { enabled: true, largeMinutes: 5, tooLargeMinutes: 5 }

  test('a small merge request gets the estimated time only, lockfiles left out', async () => {
    const { forge, submissions } = fakeForge({ files, discussions: [] })
    const { agent, tasks } = fakeAgent({ review: [review([], 'looks-good')] })
    const data = await reviewMergeRequest(runOf({ forge: requireReviewForge(forge), agent }))
    expect(data.size).toEqual({
      minutes: 11,
      level: 'ok',
      files: 1,
      lines: 4,
      groups: 0,
      model: 'agent',
    })
    expect(submissions[0]?.summary).toContain('> ⏱️ **Estimated review time: ~11 min.**')
    expect(tasks.map((task) => task.taskKind)).not.toContain('review-split')
  })

  test("the agent's own estimate is used within the bounds and kept by incremental runs", async () => {
    const { forge } = fakeForge({ files, discussions: [] })
    const { agent } = fakeAgent({ review: [{ ...review([], 'looks-good'), reviewMinutes: 15 }] })
    const data = await reviewMergeRequest(runOf({ forge: requireReviewForge(forge), agent }))
    expect(data.size).toMatchObject({ minutes: 15, agentMinutes: 15, model: 'agent' })
    const greedy = fakeAgent({ review: [{ ...review([], 'looks-good'), reviewMinutes: 600 }] })
    const capped = await reviewMergeRequest(
      runOf({
        forge: requireReviewForge(fakeForge({ files, discussions: [] }).forge),
        agent: greedy.agent,
      }),
    )
    expect(capped.size).toMatchObject({ minutes: 22, agentMinutes: 600 })
  })

  test('a too-large merge request gets the advice to split, no plan, and the note for AI agents', async () => {
    const { forge, submissions } = fakeForge({ files: twoFiles, discussions: [] })
    const { agent, tasks } = fakeAgent({
      review: [
        {
          ...review([], 'looks-good'),
          walkthrough: [{ files: ['src/price.ts'], change: 'Adds prices.' }],
          effort: 3,
        },
      ],
      'review-split': [
        splitAnswer({
          estimate: 'Translated estimate.',
          limit: 'Translated limit.',
          split: 'Translated split.',
          ai: 'Translated AI note.',
        }),
      ],
    })
    const data = await reviewMergeRequest(
      runOf({
        forge: requireReviewForge(forge),
        agent,
        options: { ...options, sizeAdvice: strict, language: 'German' },
      }),
    )
    expect(data.size?.level).toBe('too-large')
    expect(data.size?.advice?.direction).toBeUndefined()
    expect(data.size?.advice?.parts).toBeUndefined()
    const split = tasks.find((task) => task.taskKind === 'review-split')
    expect(split?.prompt).toContain('Adds prices.')
    expect(split?.prompt).not.toContain('bun.lock')
    expect(split?.system).toContain('in German')
    const summary = submissions[0]?.summary ?? ''
    expect(summary).toContain(
      '> 🛑 **Translated estimate. Translated limit.** Review effort: 3/5. Translated split.',
    )
    expect(summary).toContain('Translated split.\n>\n> _Translated AI note._')
    expect(summary).not.toContain('Merge prices first')
    expect(summary).not.toContain('src/price.ts`:')
    expect(summary).toContain('> _Translated AI note._')
    expect(summary).not.toContain('Estimated review time')
    expect(data.usage?.turns).toBe(4)
  })

  test('without an agent the advice is in English, with no plan', async () => {
    const { forge, submissions } = fakeForge({ files, discussions: [] })
    const data = await reviewMergeRequest(
      runOf({
        forge: requireReviewForge(forge),
        options: {
          ...options,
          sizeAdvice: { enabled: true, largeMinutes: 5, tooLargeMinutes: 60 },
        },
      }),
    )
    expect(data.size?.level).toBe('large')
    expect(data.size?.advice?.texts.limit).toBeUndefined()
    expect(submissions[0]?.summary).toContain('Consider splitting it into smaller merge requests')
    expect(submissions[0]?.summary).toContain('_If this code is written by an AI agent')
  })

  test('sizeAdvice off leaves the size out', async () => {
    const { forge, submissions } = fakeForge({ files, discussions: [] })
    const data = await reviewMergeRequest(
      runOf({
        forge: requireReviewForge(forge),
        options: { ...options, sizeAdvice: { enabled: false } },
      }),
    )
    expect(data.size).toBeUndefined()
    expect(submissions[0]?.summary).not.toContain('review time')
  })

  test('incremental runs repeat the advice only when the level gets worse', async () => {
    const previousHead = 'p'.repeat(40)
    const reviewOnTopOf = async (level: 'large' | 'too-large') => {
      const store = memoryStore()
      const previous: ReviewData = {
        ...(await reviewMergeRequest(
          runOf({ forge: requireReviewForge(fakeForge({ files, discussions: [] }).forge) }),
        )),
        head: previousHead,
      }
      previous.size = { minutes: 5, level, files: 1, lines: 4, groups: 1, agentMinutes: 8 }
      await store.analyses.add({
        repo,
        kind: 'review',
        ref: '!7',
        createdAt: '2026-10-29T00:00:00Z',
        data: previous,
      })
      const { forge } = fakeForge({
        files,
        discussions: [],
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
        review: [{ ...review([], 'looks-good'), reviewMinutes: 300 }],
        'review-split': [],
      })
      const data = await reviewMergeRequest(
        runOf({
          forge: requireReviewForge(forge),
          agent,
          runner: createFakeRunner(() => ({ exitCode: 0 })).runner,
          analyses: store.analyses,
          options: { ...options, sizeAdvice: strict },
        }),
      )
      return { data, tasks }
    }
    const same = await reviewOnTopOf('too-large')
    expect(same.data.mode).toBe('incremental')
    expect(same.data.size).toMatchObject({
      level: 'too-large',
      lines: 4,
      groups: 1,
      agentMinutes: 8,
      minutes: 8,
    })
    expect(same.data.size?.advice).toBeUndefined()
    expect(same.tasks.map((task) => task.taskKind)).not.toContain('review-split')

    const worse = await reviewOnTopOf('large')
    expect(worse.data.size?.advice?.texts.limit).toContain('more than a person can review')
  })

  test('a merge request over maxDiffLines gets the advice in its skip note', async () => {
    const { forge, submissions } = fakeForge({ files, discussions: [] })
    const data = await reviewMergeRequest(
      runOf({
        forge: requireReviewForge(forge),
        options: { ...options, maxDiffLines: 2, sizeAdvice: strict },
      }),
    )
    expect(data.mode).toBe('skipped')
    expect(data.size?.level).toBe('too-large')
    expect(submissions[0]?.summary).toContain('more than the limit of 2')
    expect(submissions[0]?.summary).toContain('more than a person can review thoroughly')
  })
})

const file = (path: string, status: DiffFile['status'] = 'modified'): DiffFile => ({
  oldPath: path,
  newPath: path,
  status,
  diff: '',
})

const open = (discussionId: string, path: string): OpenThread => ({
  discussionId,
  path,
  line: 1,
  text: 'x',
  ours: true,
})

describe('threadsToRecheck', () => {
  const diff = {
    refs: { baseSha: 'b', startSha: 's', headSha: 'h' },
    files: [file('src/widget.ts'), file('src/widget.test.ts')],
  }
  const threads = [
    open('untouched', 'src/widget.ts'),
    open('touched', 'src/widget.test.ts'),
    open('left', 'src/gone.ts'),
    { ...open('theirs', 'src/widget.ts'), ours: false },
  ]

  test('after new commits rechecks every open thread, the changed files first', () => {
    const result = threadsToRecheck({ diff, threads }, { since: [file('src/widget.test.ts')] })
    expect(result.recheck.map((t) => t.discussionId)).toEqual(['touched', 'untouched'])
    expect(result.gone.map((t) => t.discussionId)).toEqual(['left'])
    expect(result.changed).toEqual(['src/widget.test.ts'])
  })

  test('rechecks nothing when no file changed since the last review', () => {
    expect(threadsToRecheck({ diff, threads }, { since: [] }).recheck).toEqual([])
  })
})
