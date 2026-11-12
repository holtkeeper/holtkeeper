import { describe, expect, test } from 'bun:test'

import type { Agent, AgentTask } from '@holtkeeper/agent'

import { fakeAgent } from '../test/fakes.ts'
import {
  type ReviewPromptInput,
  SPLIT_CONCURRENCY,
  SPLIT_MAX_FILES,
  SPLIT_MAX_LINES,
  localizeFindings,
  reviewPrompt,
  reviewSystemPrompt,
  runAgentReview,
  splitReviewFiles,
} from './agent.ts'
import { addedLines, newSideLines, parseHunks } from './diff.ts'
import type { AgentReview, ReviewUsage } from './schema.ts'
import type { FileScope } from './scope.ts'

const fileOf = (path: string, lines: number): FileScope => {
  const hunks = parseHunks(
    `@@ -0,0 +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `+line ${i + 1}`).join('\n')}\n`,
  )
  return {
    path,
    oldPath: path,
    status: 'added',
    hunks,
    lines: addedLines(hunks),
    visible: newSideLines(hunks),
  }
}

const inputOf = (
  files: FileScope[],
  extra: Partial<ReviewPromptInput> = {},
): ReviewPromptInput => ({
  repo: 'shop/widgets',
  mergeRequest: { id: 3, title: 'Add widget pricing', description: 'Prices widgets.' },
  files,
  mode: 'full',
  guidelines: [],
  threads: [],
  maxComments: 15,
  ...extra,
})

const usage = (): ReviewUsage => ({ turns: 0 })

const answer = (path: string, extra: Partial<AgentReview> = {}): AgentReview => ({
  comments: [
    {
      path,
      line: 1,
      severity: 'major',
      category: 'bug',
      title: `Problem in ${path}`,
      body: 'Breaks.',
    },
  ],
  summary: `Reviewed ${path}.`,
  verdict: 'looks-good',
  ...extra,
})

const splitFiles = () => [
  fileOf('api/routes.ts', 300),
  fileOf('ui/form.ts', 250),
  fileOf('api/store.ts', 200),
  fileOf('ui/list.ts', 150),
  fileOf('lib/math.ts', 200),
]
const failingAgent = (error: Error): Agent => ({
  name: 'fake',
  async run<Output>(task: AgentTask<Output>) {
    if (task.prompt.includes('part 2 of')) throw error
    return { text: '', output: answer('api/routes.ts') as Output, turns: 1 }
  },
})

describe('reviewSystemPrompt', () => {
  test('asks for a deliberate pass that reports every distinct problem', () => {
    const prompt = reviewSystemPrompt(inputOf([fileOf('src/widget.ts', 3)]))
    expect(prompt).toContain('Go through every changed file')
    expect(prompt).toContain('callers')
    expect(prompt).toContain('retries and idempotency')
    expect(prompt).toContain('concurrency')
    expect(prompt).toContain('Report every distinct problem')
    expect(prompt).toContain('do not stop after the first one')
    expect(prompt).toContain('At most 15 comments')
    expect(prompt).toContain('Comment only on lines marked `+`')
  })

  test('writes prose in the configured language and keeps code and terms in English', () => {
    const prompt = reviewSystemPrompt(inputOf([fileOf('src/widget.ts', 3)], { language: 'German' }))
    expect(prompt).toContain('the summary and the walkthrough in German')
    expect(prompt).toContain('code comments inside them')
    expect(prompt).toContain('in English, whatever the prose language')
  })
})

describe('splitReviewFiles', () => {
  test('a diff within the limits stays one part', () => {
    const files = [fileOf('src/a.ts', 100), fileOf('src/b.ts', 100)]
    expect(splitReviewFiles(files, 'full')).toEqual([files])
  })

  test('splits a large diff by directory, balanced by changed lines, in diff order', () => {
    const files = [
      fileOf('api/routes.ts', 300),
      fileOf('ui/form.ts', 250),
      fileOf('api/store.ts', 200),
      fileOf('ui/list.ts', 150),
      fileOf('lib/math.ts', 200),
    ]
    const parts = splitReviewFiles(files, 'full')
    expect(parts.map((part) => part.map((file) => file.path))).toEqual([
      ['api/routes.ts', 'api/store.ts'],
      ['ui/form.ts', 'ui/list.ts', 'lib/math.ts'],
    ])
    for (const part of parts)
      expect(part.reduce((sum, file) => sum + file.lines.size, 0)).toBeLessThanOrEqual(
        SPLIT_MAX_LINES,
      )
  })

  test('too many files are split even when small, never over the file limit', () => {
    const files = Array.from({ length: 30 }, (_, i) => fileOf(`pkg${i % 3}/file${i}.ts`, 5))
    const parts = splitReviewFiles(files, 'full')
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.flat()).toHaveLength(30)
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(SPLIT_MAX_FILES)
      expect(new Set(part.map((file) => file.path.split('/')[0])).size).toBe(1)
    }
  })

  test('a file larger than the line limit forms its own part', () => {
    const files = [fileOf('src/huge.ts', 900), fileOf('src/small.ts', 10)]
    const parts = splitReviewFiles(files, 'full')
    expect(parts.map((part) => part.map((file) => file.path))).toEqual([
      ['src/huge.ts'],
      ['src/small.ts'],
    ])
  })
})

describe('runAgentReview', () => {
  test('a small diff runs one pass without a follow-up', async () => {
    const { agent, tasks } = fakeAgent({ review: [answer('src/widget.ts')] })
    const result = await runAgentReview({
      agent,
      dir: '/checkout',
      input: inputOf([fileOf('src/widget.ts', 20)]),
      usage: usage(),
    })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.followUpWithoutTools).toBeUndefined()
    expect(tasks[0]?.prompt).not.toContain('The diff is split')
    expect(result.candidates.map((c) => c.path)).toEqual(['src/widget.ts'])
  })

  test('a non-trivial diff asks for a follow-up when the answer reads no code', async () => {
    const { agent, tasks } = fakeAgent({ review: [answer('src/a.ts')] })
    await runAgentReview({
      agent,
      dir: '/checkout',
      input: inputOf([fileOf('src/a.ts', 60), fileOf('src/b.ts', 40)]),
      usage: usage(),
    })
    expect(tasks[0]?.followUpWithoutTools).toContain('complete JSON')
  })

  test('a large diff is reviewed in parts whose results are merged', async () => {
    const { agent, tasks } = fakeAgent({
      review: [
        answer('api/routes.ts', {
          effort: 2,
          walkthrough: [{ files: ['api/routes.ts'], change: 'A' }],
        }),
        answer('ui/form.ts', {
          verdict: 'needs-changes',
          effort: 4,
          walkthrough: [{ files: ['ui/form.ts'], change: 'B' }],
        }),
      ],
    })
    const total = usage()
    const files = [
      fileOf('api/routes.ts', 300),
      fileOf('ui/form.ts', 250),
      fileOf('api/store.ts', 200),
      fileOf('ui/list.ts', 150),
      fileOf('lib/math.ts', 200),
    ]
    const result = await runAgentReview({
      agent,
      dir: '/checkout',
      input: inputOf(files, {
        threads: [
          { discussionId: 'd1', path: 'ui/form.ts', line: 3, text: 'Old remark', ours: true },
        ],
        requests: [{ path: 'api/store.ts', line: 2, text: 'Add a test id', category: 'tests' }],
      }),
      usage: total,
    })
    expect(tasks).toHaveLength(2)
    expect(tasks[0]?.prompt).toContain('part 1 of 2')
    expect(tasks[0]?.prompt).toContain('- lib/math.ts')
    expect(tasks[0]?.prompt).toContain('# Add widget pricing')
    expect(tasks[0]?.prompt).toContain('api/store.ts:2 (tests)')
    expect(tasks[0]?.prompt).not.toContain('Old remark')
    expect(tasks[0]?.prompt).not.toContain('### ui/form.ts')
    expect(tasks[1]?.prompt).toContain('Old remark')
    expect(tasks[1]?.prompt).not.toContain('api/store.ts:2 (tests)')
    expect(result.candidates.map((c) => c.path)).toEqual(['api/routes.ts', 'ui/form.ts'])
    expect(result.summary).toBe('Reviewed api/routes.ts.\n\nReviewed ui/form.ts.')
    expect(result.verdict).toBe('needs-changes')
    expect(result.effort).toBe(4)
    expect(result.walkthrough?.map((entry) => entry.change)).toEqual(['A', 'B'])
    expect(total.turns).toBe(4)
  })

  test('a failed part keeps the findings of the others and names its files', async () => {
    const result = await runAgentReview({
      agent: failingAgent(new Error('model unavailable')),
      dir: '/checkout',
      input: inputOf(splitFiles()),
      usage: usage(),
    })
    expect(result.candidates.map((c) => c.path)).toEqual(['api/routes.ts'])
    expect(result.summary).toContain('Not reviewed')
    expect(result.summary).toContain('`ui/form.ts`')
    expect(result.verdict).toBe('needs-changes')
  })

  test('a spend limit on one part fails the review', async () => {
    const stop = new Error('cap reached')
    stop.name = 'BudgetExceededError'
    const error = await runAgentReview({
      agent: failingAgent(stop),
      dir: '/checkout',
      input: inputOf(splitFiles()),
      usage: usage(),
    }).catch((caught: unknown) => caught)
    expect(error).toBe(stop)
  })

  test('parts run at most SPLIT_CONCURRENCY at once', async () => {
    let running = 0
    let peak = 0
    const agent: Agent = {
      name: 'fake',
      async run<Output>(_task: AgentTask<Output>) {
        running++
        peak = Math.max(peak, running)
        await Bun.sleep(5)
        running--
        return { text: '', output: answer('x/a.ts') as Output, turns: 1 }
      },
    }
    const files = Array.from({ length: 8 }, (_, i) => fileOf(`dir${i}/file.ts`, 500))
    await runAgentReview({ agent, dir: '/checkout', input: inputOf(files), usage: usage() })
    expect(peak).toBe(SPLIT_CONCURRENCY)
  })

  test('the prompt of a single pass names no parts', () => {
    expect(reviewPrompt(inputOf([fileOf('src/a.ts', 3)]))).not.toContain('part 1')
  })
})

describe('localizeFindings', () => {
  const finding = {
    path: 'src/widget.tsx',
    line: 4,
    severity: 'minor' as const,
    category: 'performance' as const,
    title: 'Shorten the path data',
    body: 'Saves 12 bytes: `d` only.',
    source: 'media',
  }

  test('translates titles and bodies in one fast call and keeps everything else', async () => {
    const { agent, tasks } = fakeAgent({
      triage: [
        { items: [{ id: 0, title: 'Сократите путь', body: 'Экономит 12 байт: только `d`.' }] },
      ],
    })
    const spent: ReviewUsage = { turns: 0 }
    const [out] = await localizeFindings({
      agent,
      dir: '/tmp',
      language: 'Russian',
      candidates: [finding],
      usage: spent,
    })
    expect(out).toEqual({
      ...finding,
      title: 'Сократите путь',
      body: 'Экономит 12 байт: только `d`.',
    })
    expect(tasks[0]).toMatchObject({ tier: 'fast', maxTurns: 1, capabilities: [] })
    expect(spent.turns).toBe(2)
  })

  test('leaves English, empty answers and failures alone', async () => {
    const spent: ReviewUsage = { turns: 0 }
    const english = fakeAgent({})
    expect(
      await localizeFindings({
        agent: english.agent,
        dir: '/tmp',
        language: 'English',
        candidates: [finding],
        usage: spent,
      }),
    ).toEqual([finding])
    expect(english.tasks).toHaveLength(0)
    const empty = fakeAgent({ triage: [{ items: [] }] })
    expect(
      await localizeFindings({
        agent: empty.agent,
        dir: '/tmp',
        language: 'Russian',
        candidates: [finding],
        usage: spent,
      }),
    ).toEqual([finding])
    const failing: Agent = {
      name: 'failing',
      run: async () => {
        throw new Error('budget')
      },
    }
    expect(
      await localizeFindings({
        agent: failing,
        dir: '/tmp',
        language: 'Russian',
        candidates: [finding],
        usage: spent,
      }),
    ).toEqual([finding])
  })
})
