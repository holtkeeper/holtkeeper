import { beforeEach, describe, expect, test } from 'bun:test'

import type { Agent, AgentTask } from '@holtkeeper/agent'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import type { DiffFile, Discussion, GitForge, NoteReaction } from '@holtkeeper/forge'
import { builtinSettings } from '@holtkeeper/settings'
import type { Learning, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { z } from 'zod'

import type { ServerDeps } from '../src/context.ts'
import { createEventDispatcher } from '../src/events.ts'
import { addLearning, cleanLearningText, looksLikeFeedback } from '../src/learnings.ts'

let store: Store
let discussions: Discussion[]
let reactions: Map<string, NoteReaction[]>
let mergeRequestReads: number
let discussionReads: number
let comparison: DiffFile[] | undefined
let compared: [string, string][]

const fakeForge = {
  kind: 'gitlab',
  listDiscussions: async () => {
    discussionReads++
    return discussions
  },
  listNoteReactions: async (_repo: string, _id: number, noteId: number | string) =>
    reactions.get(String(noteId)) ?? [],
  compareCommits: async (_repo: string, from: string, to: string) => {
    compared.push([from, to])
    if (!comparison) throw new Error('cannot compare')
    return comparison
  },
  getMergeRequest: async (_repo: string, id: number) => {
    mergeRequestReads++
    return { id, webUrl: `https://forge.test/toys/kite/-/merge_requests/${id}`, headSha: 'h' }
  },
} as unknown as GitForge

const config = parseConfig({
  forges: { work: { kind: 'gitlab', url: 'https://forge.test', create: () => fakeForge } },
  teams: {
    toys: { owns: ['work:toys/*'] },
    shop: { owns: ['work:shop/*'] },
  },
  jobs: { botUsernames: { work: 'holtkeeper' } },
})

const vault = aesVault('v'.repeat(32))
const now = () => new Date('2026-11-04T10:00:00.000Z')

function fakeAgent(answers: unknown[]) {
  const tasks: AgentTask[] = []
  const agent: Agent = {
    name: 'fake',
    async run(task) {
      tasks.push(task)
      return {
        text: '',
        turns: 1,
        costUsd: 0.0003,
        model: 'fast-model',
        output: answers.shift() as never,
      }
    },
  }
  return { agent, tasks }
}

const ourComment = (id: number) => ({
  id,
  author: 'holtkeeper',
  body: '**Minor** · style — **Extract the constant**\n\nName the 42.\n\n<!-- holtkeeper:review id=f-1 -->',
  createdAt: '2026-11-04T09:00:00.000Z',
  system: false,
})

const thread = (replies: [number, string, string][]): Discussion => ({
  id: 'disc-1',
  resolvable: true,
  resolved: false,
  notes: [
    ourComment(1),
    ...replies.map(([id, author, body]) => ({
      id,
      author,
      body,
      createdAt: '2026-11-04T09:30:00.000Z',
      system: false,
    })),
  ],
  position: { path: 'src/spool.ts', line: 3, side: 'new', headSha: 'h' },
})

beforeEach(() => {
  store = memoryStore()
  discussions = []
  reactions = new Map()
  mergeRequestReads = 0
  discussionReads = 0
  comparison = []
  compared = []
})

const dispatcher = (agent: Agent | undefined, background: Promise<unknown>[]) => {
  const deps: ServerDeps = {
    config,
    auth: noAuth(),
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [],
    analyzers: [
      {
        kind: 'review',
        scope: 'repo',
        options: z.object({ mergeRequest: z.number(), replyTo: z.string().optional() }),
      },
    ],
    automaticAgentFor: async () => agent,
    onBackground: (work) => void background.push(work),
    now,
  }
  return createEventDispatcher(deps)
}
const webhook = { actor: 'webhook:gitlab', via: 'webhook' as const }
const reply = (body: string) =>
  ({
    kind: 'note',
    repo: { forge: 'work', path: 'toys/kite' },
    mergeRequest: 4,
    mergeRequestState: 'open',
    author: 'robin',
    body,
    discussionId: 'disc-1',
    inThread: true,
  }) as const

const mergeMergeRequest = async (id: number) => {
  const background: Promise<unknown>[] = []
  const outcome = await dispatcher(undefined, background)(
    {
      kind: 'mergeRequest',
      repo: { forge: 'work', path: 'toys/kite' },
      action: 'merge',
      actor: 'robin',
      newCommits: false,
      leftDraft: false,
      labelsAdded: [],
      mr: {
        id,
        title: 'Spools',
        description: '',
        sourceBranch: 'spools',
        targetBranch: 'main',
        state: 'merged',
        draft: false,
        labels: [],
        author: 'robin',
        webUrl: '',
      },
    },
    webhook,
  )
  expect(outcome.ignored).toBe('merge request is merged')
  await Promise.all(background)
}

describe('events', () => {
  test('feedback in our thread becomes one pending learning, once per note', async () => {
    const body = 'We never extract spool sizes here, they mirror the hardware sheet.'
    discussions = [thread([[2, 'robin', body]])]
    const { agent, tasks } = fakeAgent([
      { text: 'Do not ask to name spool sizes; they mirror the hardware sheet.', scope: 'repo' },
    ])
    const background: Promise<unknown>[] = []
    const dispatch = dispatcher(agent, background)
    const outcome = await dispatch(reply(body), webhook)
    expect(outcome.enqueued).toHaveLength(1)
    await Promise.all(background)
    await dispatch(reply(body), { actor: 'poll', via: 'poll' })
    await Promise.all(background)

    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ tier: 'fast', taskKind: 'learning' })
    expect(tasks[0]?.prompt).toContain('src/spool.ts')
    const [learning] = await store.learnings.list()
    expect(learning).toMatchObject({
      scope: { repos: ['work:toys/kite'] },
      origin: 'reply',
      status: 'pending',
      activeAt: '2026-11-07T10:00:00.000Z',
      sources: [
        {
          repo: 'work:toys/kite',
          mergeRequest: 4,
          discussionId: 'disc-1',
          noteId: '2',
          author: 'robin',
          url: 'https://forge.test/toys/kite/-/merge_requests/4#note_2',
        },
      ],
    })
  })

  test('a team rule from a reply is scoped to the owner teams and a repeat is merged', async () => {
    const body = 'In this repo we keep spool sizes inline on purpose.'
    discussions = [
      thread([
        [2, 'robin', body],
        [3, 'lee', `${body} Always.`],
      ]),
    ]
    const { agent } = fakeAgent([
      { text: 'Keep spool sizes inline, @robin.', scope: 'team', files: ['src/**'] },
      { text: 'Keep spool sizes inline.', scope: 'repo' },
    ])
    const background: Promise<unknown>[] = []
    const dispatch = dispatcher(agent, background)
    await dispatch(reply(body), webhook)
    await Promise.all(background)
    await dispatch({ ...reply(`${body} Always.`), author: 'lee' }, webhook)
    await Promise.all(background)
    const learnings = await store.learnings.list()
    expect(learnings).toHaveLength(1)
    expect(learnings[0]).toMatchObject({
      text: 'Keep spool sizes inline,.',
      scope: { teams: ['toys'] },
      files: ['src/**'],
    })
    expect(learnings[0]?.sources.map((source) => source.author)).toEqual(['robin', 'lee'])
  })

  test('with an approval delay of 0 a learning is active at once', async () => {
    await store.settings.put({
      id: 'delay',
      key: 'learnings.approvalDelayDays',
      scope: { teams: ['toys'] },
      value: 0,
      secret: false,
      updatedAt: '2026-10-01T00:00:00.000Z',
    })
    const body = 'In this repo we keep spool sizes inline on purpose.'
    discussions = [thread([[2, 'robin', body]])]
    const { agent } = fakeAgent([{ text: 'Keep spool sizes inline.', scope: 'repo' }])
    const background: Promise<unknown>[] = []
    await dispatcher(agent, background)(reply(body), webhook)
    await Promise.all(background)
    expect((await store.learnings.list())[0]?.status).toBe('active')
  })

  test('a question makes no call and reads nothing more from the forge', async () => {
    discussions = [thread([[2, 'robin', 'Why would this be slower?']])]
    const { agent, tasks } = fakeAgent([])
    const background: Promise<unknown>[] = []
    await dispatcher(agent, background)(reply('Why would this be slower?'), webhook)
    await Promise.all(background)
    expect(tasks).toEqual([])
    expect(mergeRequestReads).toBe(0)
    expect(await store.learnings.list()).toEqual([])
  })

  test('a merged merge request has the reactions on our comments counted', async () => {
    discussions = [
      thread([[2, 'robin', 'ok']]),
      {
        ...thread([]),
        id: 'disc-2',
        notes: [{ ...ourComment(5), body: ourComment(5).body.replace('style', 'bug') }],
      },
      {
        id: 'disc-3',
        resolvable: false,
        resolved: false,
        notes: [{ id: 9, author: 'robin', body: 'Plain comment', createdAt: '', system: false }],
      },
    ]
    reactions.set('1', [
      { name: 'thumbsdown', user: 'robin' },
      { name: 'thumbsdown', user: 'lee' },
    ])
    reactions.set('5', [{ name: 'thumbsup', user: 'lee' }])
    reactions.set('9', [{ name: 'thumbsup', user: 'lee' }])
    await mergeMergeRequest(4)
    expect(discussionReads).toBe(0)
    expect(await store.learnings.reactionTotals()).toEqual([])

    for (const ref of ['!3', '!4'])
      await store.analyses.add({
        repo: { forge: 'work', path: 'toys/kite' },
        kind: 'review',
        ref,
        createdAt: '2026-11-04T09:00:00.000Z',
        data: {},
      })
    await mergeMergeRequest(4)
    expect(discussionReads).toBe(1)
    expect(await store.learnings.reactionTotals()).toEqual([
      { category: 'bug', comments: 1, up: 1, down: 0 },
      { category: 'style', comments: 1, up: 0, down: 2 },
    ])
  })

  describe('what became of the comments', () => {
    const repo = { forge: 'work', path: 'toys/kite' }
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- helper sits with its tests
    const finding = (id: string, path: string, line: number, category = 'style') => ({
      id,
      path,
      line,
      severity: 'minor' as const,
      category: category as 'style',
      title: 'Extract the constant',
      body: 'Name the 42.',
      source: 'agent',
      posted: true,
    })
    const run = (head: string, comments: ReturnType<typeof finding>[], model: string) => ({
      mergeRequest: {
        id: 4,
        title: 'Spools',
        webUrl: 'https://forge.test/toys/kite/-/merge_requests/4',
        sourceBranch: 'spools',
        targetBranch: 'main',
        author: 'robin',
      },
      head,
      mode: 'full' as const,
      verdict: 'needs-changes' as const,
      summary: '',
      comments,
      threads: [],
      skipped: [],
      stats: {
        files: 1,
        changedLines: 3,
        dropped: { belowSeverity: 0, overLimit: 0, duplicates: 0, invalid: 0 },
      },
      approved: false,
      checks: [],
      usage: { turns: 2, model },
      promptVersion: `p-${model}`,
    })
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- helper sits with its tests
    const threadFor = (
      id: string,
      noteId: number,
      extra: Partial<Discussion> = {},
    ): Discussion => ({
      id,
      resolvable: true,
      resolved: false,
      notes: [
        {
          ...ourComment(noteId),
          body: ourComment(noteId).body.replace('f-1', id),
        },
        { id: noteId + 100, author: 'robin', body: 'Why?', createdAt: '', system: false },
      ],
      position: { path: 'src/spool.ts', line: 3, side: 'new', headSha: 'a'.repeat(40) },
      ...extra,
    })

    beforeEach(async () => {
      await store.analyses.add({
        repo,
        kind: 'review',
        ref: '!4',
        createdAt: '2026-11-04T08:00:00.000Z',
        data: run(
          'a'.repeat(40),
          [finding('fix', 'src/spool.ts', 3), finding('keep', 'src/reel.ts', 8, 'bug')],
          'model-old',
        ),
      })
      await store.analyses.add({
        repo,
        kind: 'review',
        ref: '!4',
        createdAt: '2026-11-04T09:00:00.000Z',
        data: run(
          'c'.repeat(40),
          [finding('keep', 'src/reel.ts', 8, 'bug'), finding('late', 'src/reel.ts', 20)],
          'model-new',
        ),
      })
      discussions = [
        threadFor('fix', 1),
        threadFor('keep', 2),
        threadFor('late', 3, { resolved: true }),
      ]
    })

    // oxlint-disable-next-line unicorn/consistent-function-scoping -- helper sits with its tests
    const signals = async () =>
      Object.fromEntries(
        (await store.learnings.reactions({ repo: 'work:toys/kite' })).map((signal) => [
          signal.findingId,
          signal,
        ]),
      )

    test('tells fixed, ignored and resolved comments apart, with the run that wrote them', async () => {
      comparison = [
        {
          oldPath: 'src/spool.ts',
          newPath: 'src/spool.ts',
          status: 'modified',
          diff: '@@ -3,1 +3,1 @@\n-const n = 42\n+const n = SPOOL_SIZE\n',
        },
      ]
      await mergeMergeRequest(4)
      const result = await signals()
      expect(result.fix).toMatchObject({
        outcome: 'fixed',
        mergeRequestState: 'merged',
        severity: 'minor',
        source: 'agent',
        model: 'model-old',
        promptVersion: 'p-model-old',
        humanReplies: 1,
      })
      expect(result.keep).toMatchObject({ outcome: 'ignored', model: 'model-old' })
      expect(result.late).toMatchObject({ outcome: 'resolved', model: 'model-new' })
      // Compared once per head a finding was first posted at, to the merge request's head.
      // oxlint-disable-next-line typescript/require-array-sort-compare -- plain strings
      expect(compared.toSorted()).toEqual([
        ['a'.repeat(40), 'h'],
        ['c'.repeat(40), 'h'],
      ])
    })

    test('keeps open threads unknown when the forge cannot compare the commits', async () => {
      comparison = undefined
      await mergeMergeRequest(4)
      const result = await signals()
      expect(result.fix?.outcome).toBe('unknown')
      expect(result.keep?.outcome).toBe('unknown')
      expect(result.late?.outcome).toBe('resolved')
    })

    test('a fixed comment citing a learning reinforces it once, with its reactions', async () => {
      await store.learnings.put(learning('l1'))
      discussions = discussions.map((discussion) =>
        discussion.id === 'fix'
          ? {
              ...discussion,
              notes: discussion.notes.map((note, index) =>
                index === 0
                  ? { ...note, body: note.body.replace('Name the 42.', 'Name the 42. [learn:l1]') }
                  : note,
              ),
            }
          : discussion,
      )
      reactions.set('1', [
        { name: 'thumbsup', user: 'robin' },
        { name: 'thumbsup', user: 'lee' },
      ])
      comparison = [
        {
          oldPath: 'src/spool.ts',
          newPath: 'src/spool.ts',
          status: 'modified',
          diff: '@@ -3,1 +3,1 @@\n-const n = 42\n+const n = SPOOL_SIZE\n',
        },
      ]
      await mergeMergeRequest(4)
      await mergeMergeRequest(4)
      expect(await store.learnings.get('l1')).toMatchObject({
        uses: 1,
        actedOn: 1,
        votesUp: 2,
        status: 'active',
        lastReinforcedAt: '2026-11-04T10:00:00.000Z',
      })
    })
  })
})

const learning = (id: string, overrides: Partial<Learning> = {}): Learning => ({
  id,
  text: 'Keep spool sizes in SpoolSize.',
  key: 'keep spool sizes in spoolsize',
  scope: { repos: ['work:toys/kite'] },
  origin: 'reply',
  status: 'expired',
  sources: [],
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  activeAt: '2026-06-04T00:00:00.000Z',
  lastReinforcedAt: '2026-06-04T00:00:00.000Z',
  uses: 0,
  actedOn: 0,
  votesUp: 0,
  votesDown: 0,
  ...overrides,
})

const learningDeps = () => ({ store, config, now })

describe('addLearning', () => {
  test('a person writes an active learning; a near duplicate merges its source', async () => {
    const added = await addLearning(
      learningDeps(),
      { text: 'Name tween presets by easing.', scope: { teams: ['toys'] }, origin: 'person' },
      { approvedBy: 'header:kim', newId: () => 'l-new' },
    )
    expect(added).toMatchObject({
      status: 'added',
      learning: { id: 'l-new', status: 'active', decidedBy: 'header:kim' },
    })
    const merged = await addLearning(learningDeps(), {
      text: 'name tween presets by easing',
      scope: { repos: ['work:toys/kite'] },
      origin: 'agent',
      source: { repo: 'work:toys/kite', author: 'agent', at: now().toISOString() },
    })
    expect(merged).toMatchObject({ status: 'merged', learning: { id: 'l-new' } })
    expect((await store.learnings.get('l-new'))?.sources).toHaveLength(1)
  })
})

describe('reply text', () => {
  test('acknowledgements are not feedback, conventions are', () => {
    expect(looksLikeFeedback('thanks!')).toBe(false)
    expect(looksLikeFeedback('We never extract spool sizes here.')).toBe(true)
  })

  test('names and mentions leave the rule, code stays', () => {
    expect(cleanLearningText('Ask @robin before using `@scope/spool`.', ['robin'])).toBe(
      'Ask before using `@scope/spool`.',
    )
  })
})
