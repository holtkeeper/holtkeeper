import { expect, test } from 'bun:test'

import type { Agent } from '@holtkeeper/agent'
import { goldenCases } from '@holtkeeper/review'
import { memoryStore } from '@holtkeeper/store/memory'

import { cli } from '../src/cli.ts'
import { type ReviewEvalFlags, reviewEvalCommand } from '../src/review-eval.ts'

const silent: Agent = {
  name: 'silent',
  async run(task) {
    return {
      text: '',
      output: { comments: [], summary: 'Fine.', verdict: 'looks-good' } as never,
      turns: 1,
      costUsd: 0.01,
      model: `fake-${task.tier ?? 'main'}`,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }
  },
}

const run = async (flags: ReviewEvalFlags, services = {}) => {
  const out: string[] = []
  const code = await reviewEvalCommand(
    'missing.config.ts',
    flags,
    (line) => out.push(line),
    services,
  )
  return { code, out: out.join('\n') }
}

const clean = goldenCases.find((testCase) => testCase.expected.length === 0)?.id ?? ''
const problem = goldenCases.find((testCase) => testCase.expected.length > 0)?.id ?? ''

test('prints precision and recall of the golden set', async () => {
  const { code, out } = await run(
    { case: [clean, problem], 'no-acceptance': true },
    { agent: silent },
  )
  expect(code).toBe(0)
  expect(out).toContain('Golden set: 2 cases x 1')
  expect(out).toContain('precision 100%   recall 0%')
  expect(out).toContain(`Missed:\n  ${problem}:`)
})

test('prints the golden set as JSON', async () => {
  const { out } = await run({ case: [clean], json: true, 'no-acceptance': true }, { agent: silent })
  const parsed = JSON.parse(out) as { golden: { summary: { runs: number }; results: unknown[] } }
  expect(parsed.golden.summary.runs).toBe(1)
  expect(parsed.golden.results).toHaveLength(1)
})

test('prints acceptance of real comments from the store', async () => {
  const store = memoryStore()
  const now = new Date('2025-06-01T00:00:00.000Z')
  const signals = [
    {
      repo: 'work:a',
      mergeRequest: 1,
      noteId: 'n1',
      category: 'bug',
      up: 0,
      down: 0,
      updatedAt: '2025-05-20T00:00:00.000Z',
      outcome: 'fixed',
      mergeRequestState: 'merged',
    },
    {
      repo: 'work:a',
      mergeRequest: 1,
      noteId: 'n2',
      category: 'bug',
      up: 0,
      down: 0,
      updatedAt: '2025-05-20T00:00:00.000Z',
      outcome: 'ignored',
      mergeRequestState: 'merged',
    },
    {
      repo: 'work:a',
      mergeRequest: 2,
      noteId: 'old',
      category: 'bug',
      up: 0,
      down: 0,
      updatedAt: '2024-01-01T00:00:00.000Z',
      outcome: 'ignored',
      mergeRequestState: 'merged',
    },
  ] as const
  for (const signal of signals) await store.learnings.putReactions(signal)
  const { out } = await run({ 'no-golden': true, days: '30' }, { store, now: () => now })
  expect(out).toContain('last 30 days')
  expect(out).toMatch(/bug\s+2\s+1\s+0\s+1\s+0\s+50%\s+50%/)
})

test('says so when nothing is judged yet', async () => {
  const { out } = await run({ 'no-golden': true }, { store: memoryStore() })
  expect(out).toContain('no judged comments yet')
})

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return undefined
}

test('refuses what it cannot do', async () => {
  expect(
    await refusal(run({ case: ['no-such-case'], 'no-acceptance': true }, { agent: silent })),
  ).toContain('unknown case no-such-case')
  expect(await refusal(run({ 'no-acceptance': true }, { env: {} }))).toContain('ANTHROPIC_API_KEY')
  expect(await refusal(run({ by: 'color' }))).toContain('--by expects')
  expect(await refusal(run({ repeat: '0' }))).toContain('--repeat expects')
  expect(await refusal(run({ 'no-golden': true }))).toContain('config not found')
})

test('is a command of the CLI', async () => {
  const out: string[] = []
  const err: string[] = []
  const code = await cli(['review-eval', '--no-golden', '-c', 'missing.config.ts'], {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  })
  expect(code).toBe(1)
  expect(err.join('\n')).toContain('config not found')
})
