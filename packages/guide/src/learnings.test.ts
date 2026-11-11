import { describe, expect, test } from 'bun:test'

import type { Agent, AgentTask } from '@holtkeeper/agent'
import { BudgetExceededError } from '@holtkeeper/agent'
import type { LearningSource } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'

import {
  LEARNING_RULE_MAX,
  LearningConflictError,
  acceptLearning,
  captureLearning,
  cleanRule,
  editLearning,
  looksLikeFeedback,
  normalizeRule,
  proposeRule,
  rejectLearning,
} from './learnings.ts'

const now = () => new Date('2026-11-03T08:00:00.000Z')

const source = (noteId: string, overrides: Partial<LearningSource> = {}): LearningSource => ({
  repo: 'work:toys/kite',
  mergeRequest: 4,
  discussionId: 'd1',
  noteId,
  author: 'robin',
  at: '2026-11-03T07:59:00.000Z',
  url: `https://forge.example/toys/kite/-/merge_requests/4#note_${noteId}`,
  ...overrides,
})

const reply = (noteId: string, body: string, overrides: Partial<LearningSource> = {}) => ({
  source: source(noteId, overrides),
  body,
  comment: '**Minor** · style — **Extract the constant**\n\nThe 42 should be a named constant.',
  path: 'src/spool.ts',
})

function fakeAgent(answers: unknown[]) {
  const tasks: AgentTask[] = []
  const agent: Agent = {
    name: 'fake',
    async run(task) {
      tasks.push(task)
      const output = answers.shift()
      if (output instanceof Error) throw output
      return { text: '', turns: 1, costUsd: 0.0004, model: 'fast-model', output: output as never }
    },
  }
  return { agent, tasks }
}

describe('looksLikeFeedback', () => {
  test.each([
    'We never extract spool sizes into constants here, they mirror the hardware sheet.',
    'This is intentional: the retry loop must not back off.',
    "Please don't flag magic numbers in the tween presets.",
    'У нас так принято: размеры катушек держим прямо в коде.',
  ])('passes %p', (body) => {
    expect(looksLikeFeedback(body)).toBe(true)
  })

  test.each([
    'Thanks!',
    'fixed',
    'Good catch, will change it.',
    'Why would this be slower?',
    '/holtkeeper review',
    '```ts\nwe never do this here\n```',
  ])('rejects %p', (body) => {
    expect(looksLikeFeedback(body)).toBe(false)
  })
})

test('normalizeRule ignores case, punctuation and code marks', () => {
  expect(normalizeRule('Do NOT flag `magic numbers` in presets!')).toBe(
    normalizeRule('do not flag magic numbers in presets'),
  )
})

test('cleanRule removes handles and names and caps the length', () => {
  expect(cleanRule('Ask @robin before renaming spools, as Robin said.', ['robin'])).toBe(
    'Ask before renaming spools, as said.',
  )
  const long = cleanRule(`Keep ${'very '.repeat(60)}short.`)
  expect(long.length).toBeLessThanOrEqual(LEARNING_RULE_MAX)
  expect(long.endsWith('…')).toBe(true)
})

describe('captureLearning', () => {
  test('one fast call turns feedback into a proposed candidate without names', async () => {
    const store = memoryStore()
    const { agent, tasks } = fakeAgent([
      {
        rule: 'Do not ask to extract spool sizes into constants; robin says they mirror the sheet.',
        section: 'review',
        scope: 'repo',
      },
    ])
    const outcome = await captureLearning(
      { store, agent, now, newId: () => 'c1' },
      reply('41', 'We never extract spool sizes here, they mirror the hardware sheet.'),
    )
    expect(outcome.status).toBe('proposed')
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      tier: 'fast',
      maxTurns: 1,
      capabilities: [],
      taskKind: 'learning',
      context: 'This repository has no known rules yet.',
    })
    expect(tasks[0]?.maxCostUsd).toBeLessThanOrEqual(0.02)
    const stored = await store.learnings.get('c1')
    expect(stored).toMatchObject({
      repo: 'work:toys/kite',
      rule: 'Do not ask to extract spool sizes into constants; says they mirror the sheet.',
      section: 'review',
      suggestedScope: 'repo',
      status: 'proposed',
      model: 'fast-model',
      sources: [source('41')],
    })
  })

  test('replies that are not feedback, and replies seen before, cost nothing', async () => {
    const store = memoryStore()
    const { agent, tasks } = fakeAgent([{ rule: '', section: 'review', scope: 'repo' }])
    expect(await captureLearning({ store, agent, now }, reply('1', 'Thanks, fixed.'))).toEqual({
      status: 'skipped',
      reason: 'the reply does not read like feedback',
    })
    const body = 'This is intentional, the loop must spin.'
    expect((await captureLearning({ store, agent, now }, reply('2', body))).status).toBe('none')
    expect((await captureLearning({ store, agent, now }, reply('2', body))).status).toBe('skipped')
    expect(tasks).toHaveLength(1)
  })

  test('a near-identical rule adds the reply to the existing candidate', async () => {
    const store = memoryStore()
    const { agent, tasks } = fakeAgent([
      { rule: 'Do not flag magic numbers in tween presets.', section: 'review', scope: 'repo' },
      { rule: 'do not flag magic numbers in tween presets', section: 'review', scope: 'group' },
    ])
    let id = 0
    const deps = { store, agent, now, newId: () => `c${++id}` }
    await captureLearning(deps, reply('1', "Please don't flag magic numbers in presets."))
    const second = await captureLearning(
      deps,
      reply('9', 'Again: we never name tween numbers.', { mergeRequest: 6 }),
    )
    expect(second.status).toBe('merged')
    expect(tasks[1]?.context).toContain('- Do not flag magic numbers in tween presets.')
    const all = await store.learnings.list()
    expect(all).toHaveLength(1)
    expect(all[0]?.sources.map((s) => `${s.mergeRequest}#${s.noteId}`)).toEqual(['4#1', '6#9'])
    expect(all[0]?.suggestedScope).toBe('repo')
  })

  test('a failed call releases the claim so a later delivery may retry', async () => {
    const store = memoryStore()
    const { agent, tasks } = fakeAgent([
      new BudgetExceededError('weekly budget used up'),
      { rule: 'Keep retries without backoff.', section: 'review', scope: 'repo' },
    ])
    const body = 'This is intentional: the retry loop must not back off.'
    const failed = await captureLearning({ store, agent, now }, reply('3', body)).catch(
      (error: unknown) => error,
    )
    expect(failed).toBeInstanceOf(BudgetExceededError)
    expect((await captureLearning({ store, agent, now }, reply('3', body))).status).toBe('proposed')
    expect(tasks).toHaveLength(2)
  })

  test('without an agent nothing is claimed', async () => {
    const store = memoryStore()
    const body = 'This is intentional: the retry loop must not back off.'
    expect((await captureLearning({ store, now }, reply('5', body))).status).toBe('skipped')
    expect(await store.learnings.claim('learning:work:toys/kite!4#5', now().toISOString())).toBe(
      true,
    )
  })
})

const candidate = async () => {
  const store = memoryStore()
  const { agent } = fakeAgent([
    { rule: 'Do not flag magic numbers in tween presets.', section: 'review', scope: 'repo' },
  ])
  await captureLearning(
    { store, agent, now, newId: () => 'c1' },
    reply('1', "Please don't flag magic numbers in presets."),
  )
  const stored = await store.learnings.get('c1')
  if (!stored) throw new Error('no candidate')
  return { store, stored }
}

describe('accept, edit and reject', () => {
  test('accepting puts the rule into the scope learnings; accepting again moves it', async () => {
    const { store, stored } = await candidate()
    const accepted = await acceptLearning(store, stored, {
      scope: 'repo:work:toys/kite',
      by: 'lee',
      at: '2026-11-03T09:00:00.000Z',
    })
    expect(accepted).toMatchObject({
      status: 'accepted',
      acceptedScope: 'repo:work:toys/kite',
      decidedBy: 'lee',
    })
    const section = await store.guides.get('repo:work:toys/kite', 'review')
    expect(section).toMatchObject({ rules: '', version: 0 })
    expect(section?.learnings).toEqual([
      {
        id: 'c1',
        rule: 'Do not flag magic numbers in tween presets.',
        sources: [
          {
            label: 'work:toys/kite!4',
            url: 'https://forge.example/toys/kite/-/merge_requests/4#note_1',
          },
        ],
        acceptedBy: 'lee',
        acceptedAt: '2026-11-03T09:00:00.000Z',
      },
    ])

    await acceptLearning(store, accepted, {
      scope: 'group:toys',
      rule: 'Do not flag numbers in tween presets.',
      by: 'lee',
      at: '2026-11-03T09:05:00.000Z',
    })
    expect((await store.guides.get('repo:work:toys/kite', 'review'))?.learnings).toEqual([])
    expect((await store.guides.get('group:toys', 'review'))?.learnings.map((l) => l.rule)).toEqual([
      'Do not flag numbers in tween presets.',
    ])
  })

  test('editing an accepted candidate updates its Guide entry; rejecting removes it', async () => {
    const { store, stored } = await candidate()
    const accepted = await acceptLearning(store, stored, {
      scope: 'repo:work:toys/kite',
      by: 'lee',
      at: '2026-11-03T09:00:00.000Z',
    })
    const edited = await editLearning(store, accepted, {
      rule: 'Allow literal numbers in tween presets.',
      section: 'general',
      by: 'kim',
      at: '2026-11-03T09:10:00.000Z',
    })
    expect(edited).toMatchObject({ status: 'accepted', section: 'general', editedBy: 'kim' })
    expect((await store.guides.get('repo:work:toys/kite', 'review'))?.learnings).toEqual([])
    expect(await store.guides.get('repo:work:toys/kite', 'general')).toMatchObject({
      learnings: [{ id: 'c1', rule: 'Allow literal numbers in tween presets.', acceptedBy: 'lee' }],
    })

    const rejected = await rejectLearning(store, edited, {
      by: 'kim',
      at: '2026-11-03T09:20:00.000Z',
    })
    expect(rejected.status).toBe('rejected')
    expect(rejected.acceptedScope).toBeUndefined()
    expect((await store.guides.get('repo:work:toys/kite', 'general'))?.learnings).toEqual([])
  })

  test('an edit may not copy another candidate of the repository', async () => {
    const { store, stored } = await candidate()
    await store.learnings.put({
      ...stored,
      id: 'c2',
      rule: 'Keep presets flat.',
      key: 'keep presets flat',
    })
    const conflict = await editLearning(store, stored, {
      rule: 'keep presets flat',
      by: 'kim',
      at: now().toISOString(),
    }).catch((error: unknown) => error)
    expect(conflict).toBeInstanceOf(LearningConflictError)
  })
})

describe('proposeRule', () => {
  test('stores a proposed candidate without sources and returns an existing one for the same rule', async () => {
    const store = memoryStore()
    const proposal = {
      repo: 'work:toys/kite',
      rule: 'Keep spool sizes in `SpoolSize`.',
      section: 'general' as const,
      reason: 'Two merge requests added magic numbers.',
      by: 'header:sam',
      at: now().toISOString(),
    }
    const first = await proposeRule(store, proposal, () => 'p1')
    expect(first).toMatchObject({
      status: 'proposed',
      candidate: {
        id: 'p1',
        status: 'proposed',
        suggestedScope: 'repo',
        sources: [],
        proposal: { by: 'header:sam', reason: 'Two merge requests added magic numbers.' },
        costUsd: 0,
      },
    })
    const again = await proposeRule(store, { ...proposal, rule: 'keep spool sizes in SpoolSize' })
    expect(again).toMatchObject({ status: 'exists', candidate: { id: 'p1' } })
    expect(await store.learnings.list()).toHaveLength(1)
    const empty = await proposeRule(store, { ...proposal, rule: ' ... ' }).catch(
      (error: unknown) => error,
    )
    expect(empty instanceof Error && empty.message).toBe('the rule is empty')
  })
})
