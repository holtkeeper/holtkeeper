import { describe, expect, test } from 'bun:test'

import type { Agent, AgentTask } from '@holtkeeper/agent'
import { BudgetExceededError } from '@holtkeeper/agent'
import type { LearningSource } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'

import {
  LEARNING_RULE_MAX,
  LearningConflictError,
  LearningScopeError,
  acceptLearning,
  captureLearning,
  cleanRule,
  defaultLearningScope,
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

describe('cleanRule keeps code and code-like tokens', () => {
  test.each([
    [
      'Ship the source plus .d.ts files for every widget.',
      'Ship the source plus .d.ts files for every widget.',
    ],
    ['Load secrets from .env and .mts configs.', 'Load secrets from .env and .mts configs.'],
    [
      'Start DOM-free tests with `// @vitest-environment node`.',
      'Start DOM-free tests with `// @vitest-environment node`.',
    ],
    ['Import shapes from @scope/pkg only.', 'Import shapes from @scope/pkg only.'],
    ['Declare fonts with @font-face in one file.', 'Declare fonts with @font-face in one file.'],
    [
      'Mark old helpers @deprecated before removal.',
      'Mark old helpers @deprecated before removal.',
    ],
    ['Keep `@robin` in   `a  b`  untouched.', 'Keep `@robin` in `a  b` untouched.'],
    ['ping @someone about it', 'ping about it'],
    ['Ask @robin.', 'Ask.'],
    ['Ask @robin.smith , then merge.', 'Ask, then merge.'],
    ['Keep the trailing period.', 'Keep the trailing period.'],
    ['Register routes with @app.route("/x").', 'Register routes with @app.route("/x").'],
    ['Use @pytest.mark.parametrize(x) for cases.', 'Use @pytest.mark.parametrize(x) for cases.'],
    ['Install @my.scope/pkg first.', 'Install @my.scope/pkg first.'],
    ['Use @override on subclasses.', 'Use @override on subclasses.'],
    ['Keep @jsx h at the top.', 'Keep @jsx h at the top.'],
    ['Wrap the call  , please !', 'Wrap the call, please!'],
  ])('%p', (input, expected) => {
    expect(cleanRule(input)).toBe(expected)
  })

  test('fenced code stays as written while names leave the prose', () => {
    const fence = '```ts\n// robin wrote this\nconst  widget = 1\n```'
    expect(cleanRule(`Robin says   keep ${fence} as is.`, ['robin'])).toBe(
      `says keep ${fence} as is.`,
    )
  })

  test('names glued to identifiers with an underscore stay', () => {
    expect(cleanRule('Rename robin_utils.ts and my_robin to index.', ['robin'])).toBe(
      'Rename robin_utils.ts and my_robin to index.',
    )
  })

  test('a cut that would end inside a code span ends before it', () => {
    const prose = `Keep ${'widget '.repeat(25)}`
    const rule = cleanRule(`${prose}\`some code span here\` always.`)
    expect(rule).toBe(`${prose.trimEnd()}…`)
    expect(rule.length).toBeLessThanOrEqual(LEARNING_RULE_MAX)
  })

  test('names inside paths and inline code stay', () => {
    expect(cleanRule('Robin keeps `robin.config.ts` next to robin/index.ts.', ['robin'])).toBe(
      'keeps `robin.config.ts` next to robin/index.ts.',
    )
  })
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

describe('target scopes', () => {
  const scopes = [
    'repo:work:toys/kite',
    'family:fliers',
    'group:toys.flying',
    'group:toys',
    'all',
  ] as const
  const proposal = {
    repo: 'work:toys/kite',
    rule: 'Keep spool sizes in SpoolSize.',
    section: 'general' as const,
    reason: 'Every team toy repeats it.',
    by: 'header:sam',
    at: now().toISOString(),
  }

  test('a proposal may name an exact scope of its repository and nothing else', async () => {
    const store = memoryStore()
    const outcome = await proposeRule(
      store,
      { ...proposal, targetScope: 'group:toys', scopes },
      () => 'p1',
    )
    expect(outcome.candidate).toMatchObject({ suggestedScope: 'group', targetScope: 'group:toys' })
    for (const targetScope of ['group:sheds', 'all'] as const) {
      const refused = await proposeRule(store, {
        ...proposal,
        rule: `Another rule for ${targetScope}.`,
        targetScope,
        scopes,
      }).catch((error: unknown) => error)
      expect(refused).toBeInstanceOf(LearningScopeError)
    }
    expect(await store.learnings.list()).toHaveLength(1)
  })

  test('accepting without a scope prefers the target over the nearest group of the kind', () => {
    expect(defaultLearningScope({ suggestedScope: 'group' }, scopes)).toBe('group:toys.flying')
    expect(
      defaultLearningScope({ suggestedScope: 'group', targetScope: 'group:toys' }, scopes),
    ).toBe('group:toys')
    expect(
      defaultLearningScope({ suggestedScope: 'group', targetScope: 'group:sheds' }, scopes),
    ).toBe('group:toys.flying')
    expect(defaultLearningScope({ suggestedScope: 'family' }, ['repo:work:toys/kite'])).toBe(
      undefined,
    )
  })

  test('editing a target sets its kind; a new suggested kind drops the old target', async () => {
    const store = memoryStore()
    const { candidate: proposed } = await proposeRule(store, proposal, () => 'p1')
    const at = now().toISOString()
    const targeted = await editLearning(store, proposed, {
      targetScope: 'family:fliers',
      by: 'header:lee',
      at,
    })
    expect(targeted).toMatchObject({ suggestedScope: 'family', targetScope: 'family:fliers' })
    const kept = await editLearning(store, targeted, { section: 'review', by: 'header:lee', at })
    expect(kept.targetScope).toBe('family:fliers')
    const regrouped = await editLearning(store, kept, {
      suggestedScope: 'group',
      by: 'header:lee',
      at,
    })
    expect(regrouped.suggestedScope).toBe('group')
    expect(regrouped).not.toHaveProperty('targetScope')
    const refused = await editLearning(store, regrouped, {
      targetScope: 'all',
      by: 'header:lee',
      at,
    }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(LearningScopeError)
  })
})
