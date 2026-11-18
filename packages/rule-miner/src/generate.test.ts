import { describe, expect, test } from 'bun:test'

import type { Agent, AgentTask } from '@holtkeeper/agent'

import type { ReviewComment } from './evidence.ts'
import { CALL_CAPS, acceptRules, estimateMinerCost, mineRules } from './generate.ts'
import { MINER_CONTEXT, type MinerOutput, minerPrompt } from './prompt.ts'

const comment = (id: string, mergeRequest: number, author = 'dev-two'): ReviewComment => ({
  id,
  mergeRequest: { id: mergeRequest, title: `Panel ${mergeRequest}`, webUrl: '' },
  signal: 'changed',
  text: `reviewer 1: comment ${id}`,
  source: {
    repo: 'gitlab:acme/widgets',
    mergeRequest,
    noteId: id,
    author,
    at: '2026-10-05T00:00:00.000Z',
  },
})

const comments = [comment('c1', 11), comment('c2', 12), comment('c3', 12), comment('c4', 13)]

describe('acceptRules', () => {
  test('drops unknown citations and names, merges same rules, orders by recurrence', () => {
    const output: MinerOutput = {
      rules: [
        { text: 'Keep panel titles short.', comments: ['c2'] },
        { text: 'Wrap   network calls in the retry helper.', comments: ['c1', 'c2', 'nope'] },
        { text: 'Made up rule here.', comments: ['c99'] },
        { text: 'Ask dev-two before touching panels.', comments: ['c3'] },
        { text: 'wrap network calls in the retry helper', comments: ['c4'] },
      ],
    }
    const { rules, dropped } = acceptRules(output, comments)
    expect(
      rules.map((rule) => [rule.text, rule.mergeRequests, rule.comments.map((c) => c.id)]),
    ).toEqual([
      ['Wrap network calls in the retry helper.', 3, ['c1', 'c2', 'c4']],
      ['Keep panel titles short.', 1, ['c2']],
    ])
    expect(dropped).toEqual([
      { text: 'Made up rule here.', reason: 'cites no known comment' },
      { text: 'Ask dev-two before touching panels.', reason: 'names a person' },
    ])
  })
})

describe('mineRules', () => {
  test('one tool-less capped call with the comments in the prompt', async () => {
    const tasks: AgentTask[] = []
    const agent: Agent = {
      name: 'fake',
      async run<Output>(task: AgentTask<Output>) {
        tasks.push(task)
        return {
          text: '',
          output: task.output?.parse({
            rules: [{ text: 'Keep panel titles short.', comments: ['c1'] }],
          }),
          turns: 1,
          costUsd: 0.05,
          model: 'model-main',
        }
      },
    }
    const lines: string[] = []
    const result = await mineRules({
      agent,
      dir: '/work',
      tier: 'main',
      prompt: {
        repo: 'gitlab:acme/widgets',
        since: '2026-05-01',
        maxRules: 5,
        comments,
        existing: ['Use tabs.'],
      },
      log: (line) => lines.push(line),
    })
    expect(tasks[0]).toMatchObject({
      taskKind: 'rule-miner',
      capabilities: [],
      maxTurns: 2,
      maxCostUsd: CALL_CAPS.main,
      context: MINER_CONTEXT,
    })
    expect(tasks[0]?.prompt).toContain('## [c1] !11 (lines changed after the comment)')
    expect(tasks[0]?.prompt).toContain('# Existing learnings\n- Use tabs.')
    expect(result.rules).toHaveLength(1)
    expect(result.call).toMatchObject({ tier: 'main', model: 'model-main', costUsd: 0.05 })
    expect(lines[0]).toStartWith('budget: estimate $')
  })

  test('estimate and prompt without existing learnings', () => {
    expect(estimateMinerCost(40_000, 'main', 10).usd).toBeGreaterThan(0.03)
    expect(
      minerPrompt({ repo: 'r', since: 's', maxRules: 1, comments: [], existing: [] }),
    ).toContain('# Existing learnings\nNone.')
  })
})
