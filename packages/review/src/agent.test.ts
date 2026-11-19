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
  CROSS_PART_TURNS,
  PART_MAX_TURNS,
  REVIEW_MAX_TURNS,
  dropDuplicates,
  reviewTurns,
  runAgentReview,
  splitGroupOf,
  splitReviewFiles,
  REVIEW_READ_LINES,
  REVIEW_TRIM,
  REVIEW_BUDGET_SHARES,
  MR_DIFF_TOOL,
  mergeRequestDiffTools,
  runSummary,
  SCENARIO_TURNS,
  TICKET_PROMPT_CHARS,
  isLogicFile,
  mergePassFindings,
  riskyParts,
  ticketBlock,
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
  threads: [],
  maxComments: 15,
  ...extra,
})

const usage = (): ReviewUsage => ({ turns: 0 })

/** The review passes among recorded tasks, without the scenario plan. */
const reviewTasks = (tasks: readonly AgentTask[]) =>
  tasks.filter((task) => task.taskKind === 'review')

const noFindings = (path: string) => answer(path, { comments: [] })

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

const agentFinding = (title: string) => ({
  path: 'a.ts',
  line: 1,
  severity: 'minor' as const,
  category: 'bug' as const,
  title,
  body: '',
  source: 'agent' as const,
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
    if (task.prompt.includes('final pass over the whole diff'))
      return { text: '', output: { ...answer('x.ts'), comments: [] } as Output, turns: 1 }
    return { text: '', output: answer('api/routes.ts') as Output, turns: 1 }
  },
})

const crossFails = (error: Error): Agent => ({
  name: 'fake',
  async run<Output>(task: AgentTask<Output>) {
    if (task.prompt.includes('final pass over the whole diff')) throw error
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
    expect(prompt).toContain('`reviewMinutes`')
    expect(prompt).toContain('do not stop after the first one')
    expect(prompt).toContain('At most 15 comments')
    expect(prompt).toContain('Comment only on lines marked `+`')
  })

  test('asks to ground findings in code read, to flag open suspicions and to look for tests', () => {
    const prompt = reviewSystemPrompt(inputOf([fileOf('src/widget.ts', 3)]))
    expect(prompt).toContain('Ground findings in code you read')
    expect(prompt).toContain('`evidence`')
    expect(prompt).toContain('report it with `unverified: true`')
    expect(prompt).toContain('Investigate every suspicious pattern')
    expect(prompt).toContain('Before saying tests are missing')
    expect(prompt).toContain('code.symbol with `references: true`')
    const noTests = reviewSystemPrompt(inputOf([fileOf('src/widget.ts', 3)], { tests: false }))
    expect(noTests).not.toContain('Before saying tests are missing')
  })

  test('points dependency versions at the manifests of the languages in scope', () => {
    const npm = reviewSystemPrompt(inputOf([fileOf('src/widget.ts', 3), fileOf('README.md', 1)]))
    expect(npm).toContain('from package.json, lockfiles.resolve)')
    const go = reviewSystemPrompt(inputOf([fileOf('shapes/circle.go', 3), fileOf('go.sum', 1)]))
    expect(go).toContain('from the go.mod of the module owning the file (go.sum')
    expect(go).not.toContain('package.json')
    const mixed = reviewSystemPrompt(inputOf([fileOf('web/app.tsx', 2), fileOf('api/main.go', 2)]))
    expect(mixed).toContain('package.json, lockfiles.resolve (Go code: the go.mod')
  })

  test('sends version changes and public API changes to the package tools', () => {
    const npm = reviewSystemPrompt(inputOf([fileOf('src/widget.ts', 3)]))
    expect(npm).toContain('call package_changes with `package`, `from` = a and `to` = b')
    expect(npm).toContain('for a third-party library its changelog')
    expect(npm).toContain('call package_usage for the package, then with `export`')
    expect(npm).toContain('find_packages for an organization package that already offers it')
    expect(npm).not.toContain('Go: packages under `internal/`')
    const go = reviewSystemPrompt(inputOf([fileOf('shapes/circle.go', 3)]))
    expect(go).toContain('Go: packages under `internal/` and `main` packages cannot be imported')
    expect(go).toContain('adding a method to an exported interface breaks every type')
    expect(go).toContain('Pass it as `version` to package_api')
  })

  test('forbids lockfile claims the computed section or lockfiles.resolve does not back', () => {
    const prompt = reviewSystemPrompt(inputOf([fileOf('src/widget.ts', 3)]))
    expect(prompt).toContain('Never claim that a lockfile lacks a package')
    expect(prompt).toContain(
      'when the section says a lockfile is consistent, do not ask to update it',
    )
  })

  test('places the computed dependency section before the diff', () => {
    const prompt = reviewPrompt(
      inputOf([fileOf('src/widget.ts', 3)], {
        dependencies: '## Dependency changes (computed from the lockfiles)\nConsistency: OK.',
      }),
    )
    expect(prompt.indexOf('Consistency: OK.')).toBeGreaterThan(0)
    expect(prompt.indexOf('Consistency: OK.')).toBeLessThan(prompt.indexOf('Diff:'))
    expect(reviewPrompt(inputOf([fileOf('src/widget.ts', 3)]))).not.toContain('Dependency changes')
  })

  test('lists our resolved threads so they are not raised again', () => {
    const settled = {
      discussionId: 'r',
      path: 'src/widget.ts',
      line: 2,
      text: '**Major** · bug — **Gear count is never checked**',
      ours: true,
    }
    const prompt = reviewPrompt(inputOf([fileOf('src/widget.ts', 3)], { settled: [settled] }))
    expect(prompt).toContain('Resolved threads (fixed, withdrawn or left to the author')
    expect(prompt).toContain('src/widget.ts:2 **Major** · bug — **Gear count is never checked**')
    expect(reviewPrompt(inputOf([fileOf('src/widget.ts', 3)]))).not.toContain('Resolved threads')
  })

  test('writes prose in the configured language and keeps code and terms in English', () => {
    const prompt = reviewSystemPrompt(inputOf([fileOf('src/widget.ts', 3)], { language: 'German' }))
    expect(prompt).toContain('the summary and the walkthrough in German')
    expect(prompt).toContain('code comments inside them')
    expect(prompt).toContain('in English, whatever the prose language')
  })
})

describe('splitReviewFiles', () => {
  test('test, mock and snapshot folders count as the folder above', () => {
    expect(splitGroupOf('src/widget/__tests__/widget.test.ts')).toBe('src/widget')
    expect(splitGroupOf('src/widget/__mocks__/api.ts')).toBe('src/widget')
    expect(splitGroupOf('src/widget/__tests__/__snapshots__/a.snap')).toBe('src/widget')
    expect(splitGroupOf('__tests__/root.test.ts')).toBe('')
    expect(splitGroupOf('src/widget/widget.ts')).toBe('src/widget')
    expect(splitGroupOf('README.md')).toBe('')
  })

  test('tests stay in the part of the code they test', () => {
    const files = [
      fileOf('src/gadget/gadget.ts', 300),
      fileOf('src/widget/widget.ts', 250),
      fileOf('src/widget/__tests__/widget.test.ts', 200),
      fileOf('src/gadget/__tests__/gadget.test.ts', 200),
    ]
    const parts = splitReviewFiles(files, 'full').map((part) => part.map((file) => file.path))
    expect(parts).toHaveLength(2)
    expect(parts).toContainEqual(['src/gadget/gadget.ts', 'src/gadget/__tests__/gadget.test.ts'])
    expect(parts).toContainEqual(['src/widget/widget.ts', 'src/widget/__tests__/widget.test.ts'])
  })

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
    expect(tasks[0]?.toolsets?.map((toolset) => toolset.name)).toEqual(['lockfiles'])
    expect(tasks[0]?.followUpWithoutTools).toBeUndefined()
    expect(tasks[0]?.prompt).not.toContain('The diff is split')
    expect(result.candidates.map((c) => c.path)).toEqual(['src/widget.ts'])
  })

  test('each pass gets the impact of its own files before the diff, evidence is kept', async () => {
    const { agent, tasks } = fakeAgent({
      review: [
        {
          ...answer('src/widget.ts'),
          comments: [
            {
              path: 'src/widget.ts',
              line: 1,
              severity: 'minor',
              category: 'bug',
              title: 't',
              body: 'b',
              evidence: [{ path: 'src/caller.ts', line: 4 }],
            },
          ],
        },
      ],
    })
    const asked: string[][] = []
    const result = await runAgentReview({
      agent,
      dir: '/checkout',
      input: inputOf([fileOf('src/widget.ts', 20)]),
      usage: usage(),
      impactFor: async (files) => {
        asked.push(files.map((file) => file.path))
        return '## Impact of the changed code (computed)\n\nWidget.pending is read in src/caller.ts'
      },
    })
    expect(asked).toEqual([['src/widget.ts']])
    const prompt = tasks[0]?.prompt ?? ''
    expect(prompt.indexOf('Widget.pending is read')).toBeGreaterThan(-1)
    expect(prompt.indexOf('Widget.pending is read')).toBeLessThan(prompt.indexOf('Diff:'))
    expect(result.candidates[0]?.evidence).toEqual([{ path: 'src/caller.ts', line: 4 }])
  })

  test('a failing impact section is left out', async () => {
    const { agent, tasks } = fakeAgent({ review: [answer('src/widget.ts')] })
    await runAgentReview({
      agent,
      dir: '/checkout',
      input: inputOf([fileOf('src/widget.ts', 20)]),
      usage: usage(),
      impactFor: async () => {
        throw new Error('parse failed')
      },
    })
    expect(tasks[0]?.prompt).not.toContain('Impact of the changed code')
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
    const { agent, tasks: recorded } = fakeAgent({
      review: [
        answer('api/routes.ts', {
          effort: 2,
          reviewMinutes: 20,
          walkthrough: [{ files: ['api/routes.ts'], change: 'A' }],
        }),
        answer('ui/form.ts', {
          verdict: 'needs-changes',
          effort: 4,
          reviewMinutes: 35,
          walkthrough: [{ files: ['ui/form.ts'], change: 'B' }],
        }),
        // Second passes: the same finding again, then nothing new.
        answer('api/routes.ts', { effort: 5, reviewMinutes: 50 }),
        noFindings('ui/form.ts'),
        answer('lib/math.ts', {
          walkthrough: [{ files: ['api/routes.ts', 'ui/form.ts'], change: 'A and B' }],
          reviewMinutes: 90,
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
    const plan = recorded.find((task) => task.taskKind === 'review-plan')
    expect(plan?.tier).toBe('fast')
    const tasks = reviewTasks(recorded)
    expect(tasks).toHaveLength(5)
    expect(tasks[0]?.prompt).toContain('part 1 of 2')
    expect(tasks[0]?.maxTurns).toBe(PART_MAX_TURNS)
    expect(tasks.map((task) => task.tier)).toEqual(['main', 'main', 'main', 'main', 'main'])
    expect(tasks.map((task) => task.effort)).toEqual(['high', 'high', 'high', 'high', undefined])
    // The second pass over part 1 reads its files in reverse order.
    const second = tasks[2]?.prompt ?? ''
    expect(second).toContain('part 1 of 2')
    expect(second.indexOf('### api/store.ts')).toBeLessThan(second.indexOf('### api/routes.ts'))
    const first = tasks[0]?.prompt ?? ''
    expect(first.indexOf('### api/routes.ts')).toBeLessThan(first.indexOf('### api/store.ts'))
    expect(tasks[0]?.prompt).toContain('You are the only reviewer of these lines')
    expect(tasks[0]?.prompt).toContain('- lib/math.ts')
    expect(tasks[0]?.prompt).toContain('# Add widget pricing')
    expect(tasks[0]?.prompt).toContain('api/store.ts:2 (tests)')
    expect(tasks[0]?.prompt).not.toContain('Old remark')
    expect(tasks[0]?.prompt).not.toContain('### ui/form.ts')
    expect(tasks[1]?.prompt).toContain('Old remark')
    expect(tasks[1]?.prompt).not.toContain('api/store.ts:2 (tests)')
    const cross = tasks[4]
    expect(cross?.prompt).toContain('final pass over the whole diff')
    expect(cross?.prompt).not.toContain('part 1 of')
    // The cross-part pass reads the diff on demand instead of carrying it in every turn.
    expect(cross?.prompt).not.toContain('### lib/math.ts')
    expect(cross?.prompt).toContain('- lib/math.ts (200)')
    expect(cross?.prompt).toContain('`mr.diff`')
    expect(cross?.toolsets?.some((toolset) => toolset.name === 'mr')).toBe(true)
    expect(tasks[0]?.toolsets?.some((toolset) => toolset.name === 'mr')).toBe(false)
    expect(tasks[0]?.readLines).toBe(REVIEW_READ_LINES)
    expect(tasks[0]?.trimToolResults).toEqual(REVIEW_TRIM)
    expect(cross?.prompt).toContain('- [1] api/routes.ts:1 (major) Problem in api/routes.ts')
    expect(cross?.prompt).toContain('Summaries of the parts:\n- Reviewed api/routes.ts.')
    expect(cross?.prompt).toContain(
      'Walkthroughs of the parts (change and its files):\n- A (api/routes.ts)\n- B (ui/form.ts)',
    )
    expect(cross?.maxTurns).toBe(CROSS_PART_TURNS)
    expect(result.candidates.map((c) => c.path)).toEqual([
      'api/routes.ts',
      'ui/form.ts',
      'lib/math.ts',
    ])
    // The cross-part pass writes the summary of the whole merge request.
    expect(result.summary).toBe('Reviewed lib/math.ts.')
    expect(result.verdict).toBe('needs-changes')
    expect(result.effort).toBe(4)
    expect(result.reviewMinutes).toBe(55)
    // The cross-part pass's walkthrough replaces the parts'.
    expect(result.walkthrough?.map((entry) => entry.change)).toEqual(['A and B'])
    expect(total.turns).toBe(12)
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
      async run<Output>(task: AgentTask<Output>) {
        if (task.taskKind !== 'review') return { text: '', turns: 1 }
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

  test('the turn limit grows with the slice a pass reviews', () => {
    expect(reviewTurns([fileOf('src/a.ts', 15)], 'full')).toBe(42)
    expect(reviewTurns([fileOf('src/a.ts', 300), fileOf('src/b.ts', 300)], 'full')).toBe(82)
    expect(reviewTurns([fileOf('src/a.ts', 3000)], 'full')).toBe(REVIEW_MAX_TURNS)
  })

  test('a failing cross-part pass keeps the parts, a spend limit on it fails the review', async () => {
    const stop = new Error('cap reached')
    stop.name = 'BudgetExceededError'
    const options = { dir: '/checkout', input: inputOf(splitFiles()), usage: usage() }
    const kept = await runAgentReview({ ...options, agent: crossFails(new Error('flaky')) })
    expect(kept.candidates).toHaveLength(2)
    const error = await runAgentReview({ ...options, agent: crossFails(stop) }).catch(
      (caught: unknown) => caught,
    )
    expect(error).toBe(stop)
  })

  test('with deep, parts stay on main and the cross-part pass runs on deep', async () => {
    const { agent, tasks } = fakeAgent({
      review: [answer('api/routes.ts'), answer('ui/form.ts'), answer('lib/math.ts')],
    })
    const events: unknown[] = []
    await runAgentReview({
      agent,
      dir: '/checkout',
      input: inputOf(splitFiles()),
      usage: usage(),
      deep: true,
      onProgress: (event) => events.push(event),
    })
    expect(reviewTasks(tasks).map((task) => task.tier)).toEqual([
      'main',
      'main',
      'main',
      'main',
      'deep',
    ])
    // Both parts are mostly logic, so each gets a second pass.
    expect(events).toEqual([
      { stage: 'review', parts: 4, done: 0 },
      { stage: 'review', parts: 4, done: 1 },
      { stage: 'review', parts: 4, done: 2 },
      { stage: 'review', parts: 4, done: 3 },
      { stage: 'review', parts: 4, done: 4 },
      { stage: 'cross', parts: 2 },
    ])
  })

  test('a single pass runs on deep with deep and reports one part', async () => {
    const { agent, tasks } = fakeAgent({ review: [answer('src/a.ts')] })
    const events: unknown[] = []
    await runAgentReview({
      agent,
      dir: '/checkout',
      input: inputOf([fileOf('src/a.ts', 10)]),
      usage: usage(),
      deep: true,
      onProgress: (event) => events.push(event),
    })
    expect(tasks.map((task) => task.tier)).toEqual(['deep'])
    expect(events).toEqual([{ stage: 'review', parts: 1, done: 0 }])
  })

  test('each pass logs its turns, tokens, first request size and cost', async () => {
    const { agent } = fakeAgent({ review: [answer('src/a.ts')] })
    const lines: string[] = []
    await runAgentReview({
      agent,
      dir: '/checkout',
      input: inputOf([fileOf('src/a.ts', 10)]),
      usage: usage(),
      log: (line) => lines.push(line),
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toStartWith('review pass: ')
    expect(
      runSummary({
        text: '',
        turns: 12,
        costUsd: 0.4321,
        startTokens: 14_200,
        usage: {
          inputTokens: 20_000,
          outputTokens: 900,
          cacheReadTokens: 400_000,
          cacheWriteTokens: 30_000,
        },
      }),
    ).toBe('12 turns, 450k prompt tokens, 14k at the start, $0.43')
  })

  test('mr.diff gives the numbered diff of a file of the merge request', async () => {
    const toolset = mergeRequestDiffTools([fileOf('src/a.ts', 3)])
    const tool = toolset.tools.find((entry) => entry.name === MR_DIFF_TOOL)
    const context = {} as Parameters<NonNullable<typeof tool>['run']>[1]
    expect(await tool?.run({ path: './src/a.ts' }, context)).toContain('+')
    expect(await tool?.run({ path: 'src/b.ts' }, context)).toBe(
      'error: src/b.ts is not a file of this merge request; its files: src/a.ts',
    )
  })

  test('a cost limit gives each pass its share as a soft limit', async () => {
    const { agent, tasks } = fakeAgent({
      review: [answer('api/routes.ts'), answer('ui/form.ts'), answer('lib/math.ts')],
    })
    await runAgentReview({
      agent,
      dir: '/checkout',
      input: inputOf(splitFiles()),
      usage: usage(),
      costLimitUsd: 4,
    })
    const part = (4 * REVIEW_BUDGET_SHARES.parts) / 4
    expect(reviewTasks(tasks).map((task) => task.answerAtCostUsd)).toEqual([
      part,
      part,
      part,
      part,
      4 * REVIEW_BUDGET_SHARES.cross,
    ])
  })

  test('the cross-part pass folds duplicates of the parts into the finding it keeps', async () => {
    const minor = (path: string) =>
      answer(path, {
        comments: [
          {
            path,
            line: 1,
            severity: 'minor',
            category: 'bug',
            title: `Same gap in ${path}`,
            body: 'Missing.',
          },
        ],
      })
    const { agent } = fakeAgent({
      review: [
        answer('api/routes.ts'),
        minor('ui/form.ts'),
        noFindings('api/routes.ts'),
        noFindings('ui/form.ts'),
        answer('lib/math.ts', { comments: [], duplicates: [{ id: 1, of: 2 }] }),
      ],
    })
    const result = await runAgentReview({
      agent,
      dir: '/checkout',
      input: inputOf(splitFiles()),
      usage: usage(),
    })
    expect(result.candidates.map((c) => [c.path, c.severity])).toEqual([['ui/form.ts', 'major']])
  })

  test('dropDuplicates ignores unknown, self and chained pairs', () => {
    const list = [agentFinding('A'), agentFinding('B'), agentFinding('C')]
    expect(
      dropDuplicates(list, [
        { id: 9, of: 1 },
        { id: 2, of: 2 },
      ]).map((c) => c.title),
    ).toEqual(['A', 'B', 'C'])
    expect(
      dropDuplicates(list, [
        { id: 2, of: 1 },
        { id: 3, of: 2 },
      ]).map((c) => c.title),
    ).toEqual(['A', 'C'])
  })

  test('the prompt of a single pass names no parts', () => {
    expect(reviewPrompt(inputOf([fileOf('src/a.ts', 3)]))).not.toContain('part 1')
  })

  test('an unverified finding keeps its mark, a confirmed one has none', async () => {
    const { agent } = fakeAgent({
      review: [
        answer('src/a.ts', {
          comments: [
            {
              path: 'src/a.ts',
              line: 1,
              severity: 'major',
              category: 'bug',
              title: 'Maybe',
              body: 'b',
              unverified: true,
            },
            {
              path: 'src/a.ts',
              line: 2,
              severity: 'major',
              category: 'bug',
              title: 'Sure',
              body: 'b',
              unverified: false,
            },
          ],
        }),
      ],
    })
    const result = await runAgentReview({
      agent,
      dir: '/checkout',
      input: inputOf([fileOf('src/a.ts', 5)]),
      usage: usage(),
    })
    expect(result.candidates.map((c) => [c.title, c.unverified])).toEqual([
      ['Maybe', true],
      ['Sure', undefined],
    ])
  })

  test('the scenario plan becomes the checklist of the cross-part pass', async () => {
    const { agent, tasks } = fakeAgent({
      'review-plan': [
        {
          scenarios: [
            {
              title: 'Undo after removal',
              files: ['./api/store.ts', 'ui/form.ts', 'elsewhere.ts'],
              check: 'The undo restores what the removal took.',
            },
            { title: ' ', files: [], check: 'empty title' },
          ],
        },
      ],
      review: [
        noFindings('api/routes.ts'),
        noFindings('ui/form.ts'),
        noFindings('api/routes.ts'),
        noFindings('ui/form.ts'),
        noFindings('lib/math.ts'),
      ],
    })
    const lines: string[] = []
    await runAgentReview({
      agent,
      dir: '/checkout',
      input: inputOf(splitFiles(), {
        tickets: [{ key: 'ABC-1', title: 'Widget undo', description: 'Undo must work.' }],
      }),
      usage: usage(),
      log: (line) => lines.push(line),
    })
    const plan = tasks.find((task) => task.taskKind === 'review-plan')
    expect(plan?.capabilities).toEqual([])
    expect(plan?.prompt).toContain('### api/routes.ts')
    expect(plan?.prompt).toContain('Undo must work.')
    const cross = reviewTasks(tasks).at(-1)
    expect(cross?.prompt).toContain('Scenarios to trace (mandatory)')
    expect(cross?.prompt).toContain(
      '1. Undo after removal (api/store.ts, ui/form.ts): The undo restores what the removal took.',
    )
    expect(cross?.prompt).not.toContain('empty title')
    expect(cross?.maxTurns).toBe(CROSS_PART_TURNS + SCENARIO_TURNS)
    expect(lines).toContain('scenarios traced: 0 with a problem, 0 fine, 1 not checked of 1')
  })

  test('without scenarios or with a failing plan the cross-part pass has no checklist', async () => {
    const agent: Agent = {
      name: 'fake',
      async run<Output>(task: AgentTask<Output>) {
        if (task.taskKind === 'review-plan') throw new Error('plan down')
        return { text: '', output: noFindings('x.ts') as Output, turns: 1 }
      },
    }
    const prompts: string[] = []
    await runAgentReview({
      agent: { ...agent, run: async (task) => (prompts.push(task.prompt), agent.run(task)) },
      dir: '/checkout',
      input: inputOf(splitFiles()),
      usage: usage(),
    })
    expect(prompts.at(-1)).toContain('final pass over the whole diff')
    expect(prompts.at(-1)).not.toContain('Scenarios to trace')
  })

  test('a part whose first pass fails stands on its second pass', async () => {
    let calls = 0
    const agent: Agent = {
      name: 'fake',
      async run<Output>(task: AgentTask<Output>) {
        if (task.taskKind !== 'review') return { text: '', turns: 1 }
        calls++
        if (calls === 2) throw new Error('flaky')
        return { text: '', output: answer('ui/form.ts') as Output, turns: 1 }
      },
    }
    const result = await runAgentReview({
      agent,
      dir: '/checkout',
      input: inputOf(splitFiles()),
      usage: usage(),
    })
    expect(result.summary).not.toContain('Not reviewed')
  })
})

describe('second passes', () => {
  test('only parts with enough logic get one, the most logic first', () => {
    const logic = [fileOf('src/store.ts', 400), fileOf('src/store.test.ts', 300)]
    const styles = [fileOf('ui/form.module.css', 500), fileOf('ui/form.ts', 100)]
    const small = [fileOf('lib/a.ts', 160)]
    const big = [fileOf('core/b.go', 500)]
    expect(riskyParts([logic, styles, small, big], 'full')).toEqual([0, 3])
    expect(riskyParts([styles], 'full')).toEqual([])
    expect(isLogicFile('src/__tests__/a.ts')).toBe(false)
    expect(isLogicFile('src/a.stories.tsx')).toBe(false)
    expect(isLogicFile('src/a.styles.ts')).toBe(false)
    expect(isLogicFile('locales/en.json')).toBe(false)
    expect(isLogicFile('pkg/a_test.go')).toBe(false)
    expect(isLogicFile('src/services/BetService.ts')).toBe(true)
  })

  test('merging folds repeats into the first finding and adds the rest', () => {
    const base = { ...agentFinding('Undo loses the flag'), body: 'The flag is reset.' }
    const merged = mergePassFindings(
      [{ ...base, unverified: true }, agentFinding('Other')],
      [
        {
          ...base,
          line: 2,
          severity: 'major',
          title: 'Undo resets the flag',
          evidence: [{ path: 'b.ts', line: 3 }],
        },
        { ...agentFinding('New'), path: 'c.ts' },
        { ...agentFinding('Unrelated text entirely'), line: 9 },
      ],
    )
    expect(merged.map((c) => [c.title, c.severity, c.unverified, c.evidence?.length])).toEqual([
      ['Undo loses the flag', 'major', undefined, 1],
      ['Other', 'minor', undefined, undefined],
      ['New', 'minor', undefined, undefined],
      ['Unrelated text entirely', 'minor', undefined, undefined],
    ])
  })
})

describe('ticketBlock', () => {
  test('shows read tickets and nothing without them', () => {
    expect(ticketBlock([])).toBe('')
    expect(reviewPrompt(inputOf([fileOf('src/a.ts', 3)]))).not.toContain('ticket')
    const prompt = reviewPrompt(
      inputOf([fileOf('src/a.ts', 3)], {
        tickets: [
          {
            key: 'ABC-1',
            title: 'Round  the corners',
            type: 'Story',
            status: 'In progress',
            description: `Corners are round.${'x'.repeat(TICKET_PROMPT_CHARS)}`,
          },
        ],
      }),
    )
    expect(prompt).toContain('The ticket this merge request implements, from the issue tracker.')
    expect(prompt).toContain(
      '### ABC-1 (Story, In progress): Round the corners\n\nCorners are round.',
    )
    expect(prompt).not.toContain('x'.repeat(TICKET_PROMPT_CHARS))
    expect(prompt.indexOf('ABC-1')).toBeLessThan(prompt.indexOf('Diff:'))
    expect(ticketBlock([{ key: 'ABC-2', title: 'T' }])).toContain('The ticket has no description.')
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
