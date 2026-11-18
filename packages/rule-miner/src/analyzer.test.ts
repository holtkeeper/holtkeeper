import { describe, expect, test } from 'bun:test'

import { type Agent, type AgentTask, BudgetExceededError } from '@holtkeeper/agent'
import { createFakeRunner } from '@holtkeeper/exec/testing'
import type { Learning } from '@holtkeeper/store'

import {
  type RuleMinerOptions,
  createRuleMinerAnalyzer,
  minerMarker,
  ruleMinerAnalysis,
  sourceFolderGlob,
} from './analyzer.ts'
import type { MinerOutput } from './prompt.ts'
import {
  at,
  fakeForge,
  fakeStore,
  learning,
  mergeRequest,
  note,
  replacing,
  thread,
} from './test-helpers.ts'

const repo = { forge: 'gitlab', path: 'acme/widgets' }
const NOW = '2026-11-13T10:00:00.000Z'
const SIZE_RULE = 'Validate widget sizes with the shared size guard before rendering.'
const CHANGELOG_RULE = 'Keep changelog entries in the present tense.'

const defaultAnswer = (): MinerOutput => ({
  rules: [
    { text: CHANGELOG_RULE, comments: ['c4'] },
    {
      text: SIZE_RULE,
      reason: 'Reviewers asked for it three times.',
      comments: ['c1', 'c2', 'c3'],
    },
    { text: 'Nothing backs this rule.', comments: ['c99'] },
  ],
})

function fakeAgent(answer: () => MinerOutput | Error = defaultAnswer) {
  const tasks: AgentTask[] = []
  const agent: Agent = {
    name: 'fake',
    async run<Output>(task: AgentTask<Output>) {
      tasks.push(task)
      const output = answer()
      if (output instanceof Error) throw output
      return {
        text: '',
        output: task.output?.parse(output),
        turns: 1,
        costUsd: 0.1,
        model: 'model-main',
      }
    },
  }
  return { agent, tasks }
}

const discussions = {
  13: [
    thread('d13', [note('n13', 'dev-two', 'Run the size guard first.')], {
      position: at('src/widgets/a.ts', 10),
    }),
  ],
  12: [
    thread('d12', [note('n12', 'dev-three', 'Size guard missing.')], {
      position: at('src/widgets/b.ts', 10),
    }),
    thread('d12b', [note('n12b', 'dev-two', 'Changelog should say "adds".')], { resolved: true }),
  ],
  11: [
    thread('d11', [note('n11', 'dev-two', 'Guard the size here too.')], {
      position: at('src/widgets/c.ts', 10),
    }),
  ],
}

const forgeWith = (records = [mergeRequest(11), mergeRequest(12), mergeRequest(13)]) =>
  fakeForge(
    records,
    discussions,
    replacing(10, 'src/widgets/a.ts', 'src/widgets/b.ts', 'src/widgets/c.ts'),
  )

function setup(initial: Learning[] = [], now = NOW) {
  const fakes = fakeStore(initial)
  const analyzer = createRuleMinerAnalyzer({
    store: fakes.store,
    botUsername: () => 'holt',
    policy: async () => ({ approvalDelayDays: 3, expiryDays: 90 }),
    now: () => new Date(now),
  })
  const run = (
    agent: Agent | undefined,
    options: Partial<RuleMinerOptions> = {},
    extra: { ref?: string; lines?: string[]; forge?: unknown } = {},
  ) =>
    analyzer.run({
      repo,
      dir: import.meta.dir,
      runner: createFakeRunner(() => ({ stdout: 'abc123\n' })).runner,
      ...(agent && { agent }),
      forge: (extra.forge ?? forgeWith().forge) as never,
      jobId: 'job-1',
      ...(extra.ref && { ref: extra.ref }),
      ...(extra.lines && { log: (line: string) => extra.lines?.push(line) }),
      options: {
        months: 6,
        maxLearnings: 10,
        maxMergeRequests: 80,
        discussionMergeRequests: 40,
        minComments: 3,
        tier: 'main',
        force: false,
        ...options,
      },
    })
  return { ...fakes, analyzer, run }
}

describe('sourceFolderGlob', () => {
  test('the shared folder of every path', () => {
    expect(sourceFolderGlob(['src/widgets/a.ts', 'src/widgets/deep/b.ts'])).toBe('src/widgets/**')
    expect(sourceFolderGlob(['src/a.ts', 'lib/b.ts'])).toBeUndefined()
    expect(sourceFolderGlob(['src/a.ts', undefined])).toBeUndefined()
    expect(sourceFolderGlob(['a.ts'])).toBeUndefined()
    expect(sourceFolderGlob([])).toBeUndefined()
  })
})

describe('rule-miner analyzer', () => {
  test('creates pending learnings with sources, scope and files, and marks the repository', async () => {
    const { run, learnings, values, events } = setup()
    const { agent, tasks } = fakeAgent()
    const lines: string[] = []
    const { data, sha } = await run(agent, {}, { lines })
    expect(sha).toBe('abc123')
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.prompt).toContain('Write at most 10 rules')
    expect(tasks[0]?.prompt).toContain('reviewer 1: Run the size guard first.')
    expect(tasks[0]?.prompt).not.toContain('dev-two')
    expect(data).toMatchObject({
      outcome: 'mined',
      firstRun: true,
      window: { since: '2026-05-13T10:00:00.000Z', mergeRequests: 3, threads: 4, comments: 4 },
      version: 1,
    })
    expect(data.rules.map((rule) => [rule.text, rule.outcome])).toEqual([
      ['Nothing backs this rule.', 'dropped'],
      [SIZE_RULE, 'created'],
      [CHANGELOG_RULE, 'created'],
    ])
    const stored = [...learnings.values()]
    const size = stored.find((item) => item.text === SIZE_RULE)
    expect(size).toMatchObject({
      origin: 'miner',
      status: 'pending',
      scope: { repos: ['gitlab:acme/widgets'] },
      files: ['src/widgets/**'],
      reason: 'Reviewers asked for it three times.',
      model: 'model-main',
      costUsd: 0.05,
      createdAt: NOW,
      activeAt: '2026-11-16T10:00:00.000Z',
    })
    expect(size?.decidedBy).toBeUndefined()
    expect(
      size?.sources.map((source) => [source.mergeRequest, source.noteId, source.author]),
    ).toEqual([
      [13, 'n13', 'dev-two'],
      [12, 'n12', 'dev-three'],
      [11, 'n11', 'dev-two'],
    ])
    expect(size?.sources[0]?.url).toBe(
      'https://forge.test/acme/widgets/-/merge_requests/13#note_n13',
    )
    expect(stored.find((item) => item.text === CHANGELOG_RULE)?.files).toBeUndefined()
    expect(values.get(minerMarker(repo))).toEqual({
      at: NOW,
      jobId: 'job-1',
      minedUntil: NOW,
      runs: 1,
      created: 2,
    })
    expect(events.map((event) => [event.action, event.actor.id, event.target.repo])).toEqual([
      ['learning.create', 'agent:rule-miner', 'gitlab:acme/widgets'],
      ['learning.create', 'agent:rule-miner', 'gitlab:acme/widgets'],
    ])
    expect(lines).toContain('dropped "Nothing backs this rule." — cites no known comment')
    expect(ruleMinerAnalysis.schema.parse(data)).toEqual(data)
    const report = ruleMinerAnalysis.toReport({
      id: 'a',
      kind: 'rule-miner',
      repo,
      data,
      createdAt: NOW,
    })
    expect(report.subtitle).toStartWith('model-main, $0.1000 (estimated $')
  })

  test('merges a near-duplicate into the existing learning instead of creating one', async () => {
    const existing = learning({
      id: 'l-size',
      text: 'Validate widget sizes with the shared size guard before rendering',
      key: 'validate widget sizes with the shared size guard before rendering',
      scope: { repos: ['gitlab:acme/gadgets'] },
      status: 'expired',
    })
    const { run, learnings, events } = setup([existing])
    const { agent, tasks } = fakeAgent()
    const { data } = await run(agent)
    expect(tasks[0]?.prompt).toContain('# Existing learnings\nNone.')
    const record = data.rules.find((rule) => rule.text === SIZE_RULE)
    expect(record).toMatchObject({ outcome: 'duplicate', learningId: 'l-size', added: 3 })
    const merged = learnings.get('l-size')
    expect(merged?.sources).toHaveLength(3)
    expect(merged?.status).toBe('active')
    expect(merged?.lastReinforcedAt).toBe(NOW)
    expect(merged?.scope.repos).toEqual(['gitlab:acme/gadgets', 'gitlab:acme/widgets'])
    expect(learnings.size).toBe(2)
    expect(events.map((event) => event.action)).toEqual(['learning.reinforce', 'learning.create'])
  })

  test('lists learnings of the repository in the prompt and caps new ones', async () => {
    const existing = learning({
      id: 'l-own',
      text: 'Prefer named exports.',
      key: 'prefer named exports',
    })
    const { run, learnings } = setup([existing])
    const { agent, tasks } = fakeAgent()
    const { data } = await run(agent, { maxLearnings: 1 })
    expect(tasks[0]?.prompt).toContain('# Existing learnings\n- Prefer named exports.')
    expect(tasks[0]?.prompt).toContain('Write at most 1 rules')
    expect(data.rules.map((rule) => rule.outcome)).toEqual(['dropped', 'created', 'skipped'])
    expect(data.rules[2]?.why).toBe('over the limit of 1 new learnings')
    expect(learnings.size).toBe(2)
  })

  test('runs once per 14 days; the next run reads from the last one and creates at most 5', async () => {
    const first = setup()
    await first.run(fakeAgent().agent)
    const mark = first.values.get(minerMarker(repo))
    expect(await first.analyzer.appliesTo?.({ repo, forge: undefined as never })).toBe(false)
    const lines: string[] = []
    const again = await first.run(fakeAgent().agent, {}, { lines })
    expect(again.data).toMatchObject({ outcome: 'skipped' })
    expect(again.data.reason).toContain('mined 2026-11-13')

    const later = setup([], '2026-11-28T10:00:00.000Z')
    later.values.set(minerMarker(repo), mark)
    expect(await later.analyzer.appliesTo?.({ repo, forge: undefined as never })).toBe(true)
    const { agent, tasks } = fakeAgent()
    const { forge, calls } = forgeWith(
      [11, 12, 13].map((id) => mergeRequest(id, { mergedAt: '2026-11-20T00:00:00.000Z' })),
    )
    const { data } = await later.run(agent, {}, { forge })
    expect(calls[0]).toBe('list acme/widgets merged 2026-11-13T10:00:00.000Z 80')
    expect(data.firstRun).toBe(false)
    expect(tasks[0]?.prompt).toContain('Write at most 5 rules')
    expect(later.values.get(minerMarker(repo))).toMatchObject({ runs: 2, created: 4 })
  })

  test('too few comments: no call, the window stays', async () => {
    const { run, values } = setup()
    const { agent, tasks } = fakeAgent()
    const { data } = await run(agent, { minComments: 10 })
    expect(tasks).toHaveLength(0)
    expect(data.outcome).toBe('skipped')
    expect(data.reason).toContain('waiting for 10')
    expect(values.get(minerMarker(repo))).toEqual({ at: NOW, jobId: 'job-1', runs: 0, created: 0 })
  })

  test('skips without an agent, refuses a ref, propagates a budget refusal unmarked', async () => {
    const { run, values } = setup()
    expect((await run(undefined)).data.reason).toBe('no AI agent is configured')
    expect(values.size).toBe(0)
    expect(run(fakeAgent().agent, {}, { ref: 'v1' })).rejects.toThrow(
      'reads only the default branch',
    )
    const { agent } = fakeAgent(() => new BudgetExceededError('weekly budget used up'))
    expect(run(agent)).rejects.toBeInstanceOf(BudgetExceededError)
    expect(values.size).toBe(0)
  })

  test('without deps it applies but cannot run', async () => {
    const analyzer = createRuleMinerAnalyzer()
    expect(analyzer.kind).toBe('rule-miner')
    expect(await analyzer.appliesTo?.({ repo, forge: undefined as never })).toBe(true)
  })
})
