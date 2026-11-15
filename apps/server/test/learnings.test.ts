import { beforeEach, describe, expect, test } from 'bun:test'

import type { Agent, AgentTask } from '@holtkeeper/agent'
import type {
  AcceptLearningsResult,
  LearningCandidate,
  LearningList,
  ReactionTotalsList,
} from '@holtkeeper/api'
import type { AuthProvider } from '@holtkeeper/auth'
import { headerAuth } from '@holtkeeper/auth-header'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import type { DiffFile, Discussion, GitForge, NoteReaction } from '@holtkeeper/forge'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { z } from 'zod'

import { createApp } from '../src/app.ts'
import type { ServerDeps } from '../src/context.ts'
import { createEventDispatcher } from '../src/events.ts'
import { autoAcceptLearning, learningConfidence, learningSourceKind } from '../src/learnings.ts'

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
  test('feedback in our thread becomes one proposed candidate, once per note', async () => {
    const body = 'We never extract spool sizes here, they mirror the hardware sheet.'
    discussions = [thread([[2, 'robin', body]])]
    const { agent, tasks } = fakeAgent([
      {
        rule: 'Do not ask to name spool sizes; they mirror the hardware sheet.',
        section: 'review',
        scope: 'repo',
      },
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
    const [candidate] = await store.learnings.list()
    expect(candidate).toMatchObject({
      repo: 'work:toys/kite',
      status: 'proposed',
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

  test('with review-reply auto-accept a new candidate goes straight into the Guide', async () => {
    await store.settings.put({
      id: 'auto',
      key: 'learnings.autoAccept',
      scope: { teams: ['toys'] },
      value: { sources: ['review-reply'], scope: 'suggested' },
      secret: false,
      updatedAt: '2026-10-01T00:00:00.000Z',
    })
    const body = 'In this repo we keep spool sizes inline on purpose.'
    discussions = [thread([[2, 'robin', body]])]
    const { agent } = fakeAgent([
      { rule: 'Keep spool sizes inline.', section: 'review', scope: 'team' },
    ])
    const background: Promise<unknown>[] = []
    await dispatcher(agent, background)(reply(body), webhook)
    await Promise.all(background)

    const [candidate] = await store.learnings.list()
    expect(candidate).toMatchObject({
      status: 'accepted',
      acceptedScope: 'team:toys',
      decidedBy: 'auto-accept',
    })
    expect((await store.guides.get('team:toys', 'review'))?.learnings).toMatchObject([
      { rule: 'Keep spool sizes inline.', acceptedBy: 'auto-accept' },
    ])
    expect((await store.audit.list({ action: 'learning.accept' })).events).toMatchObject([
      { actor: { id: 'auto-accept' }, details: { auto: true, origin: 'review-reply' } },
    ])
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
  })
})

const candidate = (id: string, overrides: Partial<LearningCandidate> = {}): LearningCandidate => ({
  id,
  repo: 'work:toys/kite',
  rule: 'Do not flag magic numbers in tween presets.',
  key: 'do not flag magic numbers in tween presets',
  section: 'review',
  suggestedScope: 'repo',
  status: 'proposed',
  sources: [
    {
      repo: 'work:toys/kite',
      mergeRequest: 4,
      discussionId: 'disc-1',
      noteId: '2',
      author: 'robin',
      at: '2026-11-04T09:30:00.000Z',
    },
  ],
  model: 'fast-model',
  costUsd: 0.0003,
  createdAt: '2026-11-04T09:31:00.000Z',
  updatedAt: '2026-11-04T09:31:00.000Z',
  ...overrides,
})

let clock = 0
const setup = (auth: AuthProvider = noAuth(), appConfig = config) =>
  createApp({
    config: appConfig,
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [],
    now: () => new Date(Date.UTC(2026, 10, 4, 12, clock++)),
  })

const teams = headerAuth({
  roles: {
    reader: [{ scope: { teams: ['toys'] }, actions: ['knowledge:read'] }],
    member: [{ scope: { teams: ['toys'] }, actions: ['knowledge:read', 'knowledge:write'] }],
    lead: [
      {
        scope: { teams: ['toys'] },
        actions: ['knowledge:read', 'knowledge:write', 'settings:write'],
      },
    ],
  },
})
const as = (role: string) => ({ 'x-forwarded-user': role, 'x-forwarded-groups': role })

const send = (
  app: ReturnType<typeof setup>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

describe('routes', () => {
  beforeEach(async () => {
    await store.learnings.put(candidate('c1'))
    await store.learnings.put(
      candidate('c2', { repo: 'work:shop/till', key: 'other', suggestedScope: 'team' }),
    )
  })

  test('lists what the caller may read, with the scopes it may accept into', async () => {
    const app = setup(teams)
    const member = (await (
      await send(app, 'GET', '/api/learnings', undefined, as('member'))
    ).json()) as LearningList
    expect(member.candidates.map((c) => [c.id, c.canDecide, c.scopes])).toEqual([
      ['c1', true, ['repo:work:toys/kite']],
    ])
    const lead = (await (
      await send(app, 'GET', '/api/learnings?status=proposed', undefined, as('lead'))
    ).json()) as LearningList
    expect(lead.candidates[0]?.scopes).toEqual(['repo:work:toys/kite', 'team:toys'])
    const reader = (await (
      await send(app, 'GET', '/api/learnings', undefined, as('reader'))
    ).json()) as LearningList
    expect(reader.candidates.map((c) => [c.id, c.canDecide, c.scopes])).toEqual([['c1', false, []]])
    expect(
      (await send(app, 'GET', '/api/learnings?status=maybe', undefined, as('reader'))).status,
    ).toBe(400)
  })

  test('accepting puts the rule into the Guide; team scopes need settings:write', async () => {
    const app = setup(teams)
    expect((await send(app, 'POST', '/api/learnings/c1/accept', {}, as('reader'))).status).toBe(403)
    expect(
      (await send(app, 'POST', '/api/learnings/c1/accept', { scope: 'team:toys' }, as('member')))
        .status,
    ).toBe(403)
    expect(
      (await send(app, 'POST', '/api/learnings/c1/accept', { scope: 'team:shop' }, as('lead')))
        .status,
    ).toBe(400)
    const accepted = await send(
      app,
      'POST',
      '/api/learnings/c1/accept',
      { rule: 'Allow literal numbers in tween presets.' },
      as('member'),
    )
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({
      status: 'accepted',
      acceptedScope: 'repo:work:toys/kite',
      rule: 'Allow literal numbers in tween presets.',
      decidedBy: 'header:member',
    })
    expect((await store.guides.get('repo:work:toys/kite', 'review'))?.learnings).toMatchObject([
      { id: 'c1', rule: 'Allow literal numbers in tween presets.', acceptedBy: 'header:member' },
    ])
    const events = (await store.audit.list({ repo: 'work:toys/kite' })).events
    expect(events.map((event) => event.action)).toContain('learning.accept')
    const denied = (await store.audit.list({ outcome: 'denied' })).events
    expect(denied.every((event) => event.target.repo === undefined)).toBe(true)
  })

  test('editing and rejecting follow the Guide entry; unknown ids are 404', async () => {
    const app = setup()
    await send(app, 'POST', '/api/learnings/c1/accept', {})
    const edited = await send(app, 'PATCH', '/api/learnings/c1', { section: 'general' })
    expect(await edited.json()).toMatchObject({ section: 'general', status: 'accepted' })
    expect((await store.guides.get('repo:work:toys/kite', 'general'))?.learnings).toHaveLength(1)
    const rejected = await send(app, 'POST', '/api/learnings/c1/reject')
    expect(await rejected.json()).toMatchObject({ status: 'rejected' })
    expect((await store.guides.get('repo:work:toys/kite', 'general'))?.learnings).toEqual([])
    expect((await send(app, 'POST', '/api/learnings/nope/reject')).status).toBe(404)
  })

  test('an auto-accepted rule names Auto-accept and a person can still reject it', async () => {
    const app = setup(teams)
    await store.settings.put({
      id: 'auto',
      key: 'learnings.autoAccept',
      scope: { all: true },
      value: { sources: ['review-reply'] },
      secret: false,
      updatedAt: '2026-10-01T00:00:00.000Z',
    })
    const proposed = await store.learnings.get('c1')
    const accepted =
      proposed && (await autoAcceptLearning({ store, config, now }, proposed, 'review-reply'))
    expect(accepted).toMatchObject({ acceptedScope: 'repo:work:toys/kite' })
    expect(
      await autoAcceptLearning({ store, config, now }, candidate('c9', { key: 'k9' }), 'mcp'),
    ).toBeUndefined()

    const list = (await (
      await send(app, 'GET', '/api/learnings?status=accepted', undefined, as('member'))
    ).json()) as LearningList
    expect(list.candidates.map((c) => [c.id, c.decidedBy])).toEqual([['c1', 'auto-accept']])
    expect(list.people['auto-accept']?.name).toBe('Auto-accept')

    const rejected = await send(app, 'POST', '/api/learnings/c1/reject', undefined, as('member'))
    expect(await rejected.json()).toMatchObject({ status: 'rejected', decidedBy: 'header:member' })
    expect((await store.guides.get('repo:work:toys/kite', 'review'))?.learnings).toEqual([])
  })

  test('accepting a team suggestion without an owner team needs a scope', async () => {
    await store.learnings.put(
      candidate('c3', { repo: 'work:lonely/one', key: 'k3', suggestedScope: 'team' }),
    )
    const app = setup()
    expect((await send(app, 'POST', '/api/learnings/c3/accept', {})).status).toBe(400)
    expect((await send(app, 'POST', '/api/learnings/c2/accept', {})).status).toBe(200)
    expect((await store.guides.get('team:shop', 'review'))?.learnings).toHaveLength(1)
  })

  test('a path suggestion lands in the folder holding the repository; wider ones stay choosable', async () => {
    const nested = parseConfig({
      forges: config.forges,
      teams: { toys: { owns: ['work:toys/**'] } },
    })
    const kite = { repo: 'work:toys/air/kite', sources: [] }
    await store.learnings.put(
      candidate('c3', { ...kite, key: 'k3', rule: 'Keep kites light.', suggestedScope: 'path' }),
    )
    await store.learnings.put(
      candidate('c4', { ...kite, key: 'k4', rule: 'Name every toy.', suggestedScope: 'path' }),
    )
    const app = setup(noAuth(), nested)
    const list = (await (await send(app, 'GET', '/api/learnings')).json()) as LearningList
    expect(list.candidates.find((c) => c.id === 'c3')?.scopes).toEqual([
      'repo:work:toys/air/kite',
      'path:work:toys/air',
      'path:work:toys',
      'team:toys',
      'all',
    ])
    expect(await (await send(app, 'POST', '/api/learnings/c3/accept', {})).json()).toMatchObject({
      acceptedScope: 'path:work:toys/air',
    })
    expect(
      await (
        await send(app, 'POST', '/api/learnings/c4/accept', { scope: 'path:work:toys' })
      ).json(),
    ).toMatchObject({ acceptedScope: 'path:work:toys' })
    expect((await store.guides.get('path:work:toys/air', 'review'))?.learnings).toHaveLength(1)
    expect((await store.guides.get('path:work:toys', 'review'))?.learnings).toHaveLength(1)
  })

  test('a folder entry auto-accepts a rule aimed at the owner team into the repository', async () => {
    const nested = parseConfig({
      forges: config.forges,
      teams: { toys: { owns: ['work:toys/**'] } },
    })
    await store.settings.put({
      id: 'auto',
      key: 'learnings.autoAccept',
      scope: { repos: ['work:toys/air/**'] },
      value: { sources: ['mcp', 'review-reply'] },
      secret: false,
      updatedAt: '2026-10-01T00:00:00.000Z',
    })
    const deps = { store, config: nested, now }
    const proposed = candidate('c5', {
      repo: 'work:toys/air/kite',
      rule: 'Name every toy.',
      key: 'name every toy',
      sources: [],
      proposal: { by: 'header:reader', reason: 'Seen twice.' },
      targetScope: 'team:toys',
    })
    const replied = candidate('c6', {
      repo: 'work:toys/air/kite',
      rule: 'Keep kites light.',
      key: 'keep kites light',
      suggestedScope: 'path',
      sources: [
        {
          repo: 'work:toys/air/kite',
          mergeRequest: 4,
          discussionId: 'disc-1',
          noteId: '2',
          author: 'robin',
          at: '2026-11-04T09:30:00.000Z',
          url: 'https://forge.test/toys/air/kite/-/merge_requests/4#note_2',
        },
      ],
    })
    await store.learnings.put(proposed)
    await store.learnings.put(replied)
    expect(await autoAcceptLearning(deps, proposed, 'mcp')).toMatchObject({
      acceptedScope: 'repo:work:toys/air/kite',
    })
    expect(await store.guides.get('team:toys', 'review')).toBeUndefined()
    expect(await autoAcceptLearning(deps, replied, 'review-reply')).toMatchObject({
      acceptedScope: 'path:work:toys/air',
    })
    const { events } = await store.audit.list({ action: 'learning.accept' })
    expect(events.map((event) => event.details)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ origin: 'mcp', proposedBy: 'header:reader' }),
        expect.objectContaining({
          origin: 'review-reply',
          author: 'robin',
          mergeRequest: 4,
          url: 'https://forge.test/toys/air/kite/-/merge_requests/4#note_2',
        }),
      ]),
    )
  })

  test('a target scope picks a wider folder or the owner team and stays among the repository scopes', async () => {
    const nested = parseConfig({
      forges: config.forges,
      teams: {
        toys: { owns: ['work:toys/**'] },
        shop: { owns: ['work:shop/*'] },
      },
    })
    const kite = { repo: 'work:toys/air/kite', sources: [] }
    await store.learnings.put(
      candidate('c3', {
        ...kite,
        key: 'k3',
        rule: 'Name every toy.',
        suggestedScope: 'path',
        targetScope: 'team:toys',
      }),
    )
    await store.learnings.put(candidate('c4', { ...kite, key: 'k4', rule: 'Keep kites light.' }))
    const app = setup(noAuth(), nested)
    expect(await (await send(app, 'POST', '/api/learnings/c3/accept', {})).json()).toMatchObject({
      acceptedScope: 'team:toys',
    })
    expect(
      (await send(app, 'PATCH', '/api/learnings/c4', { targetScope: 'team:shop' })).status,
    ).toBe(400)
    expect(
      (await send(app, 'PATCH', '/api/learnings/c4', { targetScope: 'path:work:shop' })).status,
    ).toBe(400)
    expect((await send(app, 'PATCH', '/api/learnings/c4', { targetScope: 'all' })).status).toBe(400)
    expect(
      await (
        await send(app, 'PATCH', '/api/learnings/c4', { targetScope: 'path:work:toys' })
      ).json(),
    ).toMatchObject({ suggestedScope: 'path', targetScope: 'path:work:toys' })
    expect(await (await send(app, 'POST', '/api/learnings/c4/accept', {})).json()).toMatchObject({
      acceptedScope: 'path:work:toys',
    })
  })

  test('setting a target scope needs edit rights on it', async () => {
    const app = setup(teams)
    expect(
      (await send(app, 'PATCH', '/api/learnings/c1', { targetScope: 'team:toys' }, as('member')))
        .status,
    ).toBe(403)
    expect(
      await (
        await send(app, 'PATCH', '/api/learnings/c1', { targetScope: 'team:toys' }, as('lead'))
      ).json(),
    ).toMatchObject({ targetScope: 'team:toys' })
    const events = (await store.audit.list({ action: 'learning.update' })).events
    expect(events.find((event) => event.outcome === 'ok')?.changes).toContainEqual({
      field: 'target',
      after: 'team:toys',
    })
  })

  test('views drop a target scope the repository no longer has', async () => {
    await store.learnings.put(candidate('c3', { key: 'k3', targetScope: 'family:gone' }))
    const list = (await (await send(setup(), 'GET', '/api/learnings')).json()) as LearningList
    expect(list.candidates.find((row) => row.id === 'c3')).not.toHaveProperty('targetScope')
  })

  test('a target scope of all is refused as input before any rights check', async () => {
    const app = setup(teams)
    expect(
      (await send(app, 'PATCH', '/api/learnings/c1', { targetScope: 'all' }, as('member'))).status,
    ).toBe(400)
  })

  test('rows carry how the candidate came about and a confidence from its sources', async () => {
    await store.learnings.put(
      candidate('c3', {
        key: 'k3',
        sources: [
          { ...candidate('x').sources[0]!, discussionId: 'disc-1', author: 'robin' },
          { ...candidate('x').sources[0]!, discussionId: 'disc-2', noteId: '7', author: 'lee' },
        ],
      }),
    )
    await store.learnings.put(
      candidate('c4', {
        key: 'k4',
        sources: [],
        proposal: { by: 'mcp:bot', reason: 'seen twice' },
      }),
    )
    const list = (await (await send(setup(), 'GET', '/api/learnings')).json()) as LearningList
    const rows = Object.fromEntries(
      list.candidates.map((row) => [row.id, [row.sourceKind, row.confidence]]),
    )
    expect(rows).toEqual({
      c1: ['review-reply', 1],
      c2: ['review-reply', 2],
      c3: ['merged', 3],
      c4: ['mcp', 1],
    })
  })

  test('accepts several at once with one audit event per accepted candidate', async () => {
    await store.learnings.put(candidate('c3', { key: 'k3', repo: 'work:toys/yoyo' }))
    const app = setup(teams)
    const response = await send(
      app,
      'POST',
      '/api/learnings/accept',
      { ids: ['c1', 'c2', 'nope', 'c3', 'c1'] },
      as('member'),
    )
    expect(response.status).toBe(200)
    expect((await response.json()) as AcceptLearningsResult).toEqual({
      accepted: ['c1', 'c3'],
      failed: [
        { id: 'c2', error: 'learning candidate not found' },
        { id: 'nope', error: 'learning candidate not found' },
      ],
    })
    expect((await store.learnings.get('c2'))?.status).toBe('proposed')
    const events = (await store.audit.list({ action: 'learning.accept' })).events
    expect(
      events
        .map((event) => [event.action, event.target.id, event.target.repo])
        .toSorted((a, b) => String(a[1]).localeCompare(String(b[1]))),
    ).toEqual([
      ['learning.accept', 'c1', 'work:toys/kite'],
      ['learning.accept', 'c3', 'work:toys/yoyo'],
    ])
    expect(events[0]?.actor.id).toBe('header:member')
    expect(events[0]?.changes).toContainEqual({
      field: 'status',
      before: 'proposed',
      after: 'accepted',
    })
    const batch = (await store.audit.list({ action: 'learnings.accept' })).events
    expect(batch).toHaveLength(1)
    expect(batch[0]?.details).toEqual({ accepted: 2, failed: 2 })
  })

  test('a batch checks rights per candidate and per target scope', async () => {
    const app = setup(teams)
    const reader = (await (
      await send(app, 'POST', '/api/learnings/accept', { ids: ['c1'] }, as('reader'))
    ).json()) as AcceptLearningsResult
    expect(reader).toEqual({
      accepted: [],
      failed: [{ id: 'c1', error: 'missing permission knowledge:write' }],
    })
    const team = (await (
      await send(
        app,
        'POST',
        '/api/learnings/accept',
        { ids: ['c1'], scope: 'team:toys' },
        as('member'),
      )
    ).json()) as AcceptLearningsResult
    expect(team.failed).toEqual([{ id: 'c1', error: 'missing permission to edit team:toys' }])
    const elsewhere = (await (
      await send(
        app,
        'POST',
        '/api/learnings/accept',
        { ids: ['c1'], scope: 'team:shop' },
        as('lead'),
      )
    ).json()) as AcceptLearningsResult
    expect(elsewhere.failed).toEqual([
      { id: 'c1', error: 'team:shop does not apply to work:toys/kite' },
    ])
    const lead = (await (
      await send(
        app,
        'POST',
        '/api/learnings/accept',
        { ids: ['c1'], scope: 'team:toys' },
        as('lead'),
      )
    ).json()) as AcceptLearningsResult
    expect(lead).toEqual({ accepted: ['c1'], failed: [] })
    expect((await store.guides.get('team:toys', 'review'))?.learnings).toHaveLength(1)
    expect((await store.audit.list({ action: 'learning.accept' })).events).toHaveLength(1)
    expect((await send(app, 'POST', '/api/learnings/accept', { ids: [] }, as('lead'))).status).toBe(
      400,
    )
  })

  test('reaction totals per category', async () => {
    await store.learnings.putReactions({
      repo: 'work:toys/kite',
      mergeRequest: 4,
      noteId: '1',
      category: 'style',
      up: 0,
      down: 2,
      updatedAt: now().toISOString(),
    })
    const app = setup(teams)
    const totals = (await (
      await send(
        app,
        'GET',
        '/api/learnings/reactions?repo=work:toys/kite',
        undefined,
        as('reader'),
      )
    ).json()) as ReactionTotalsList
    expect(totals.totals).toEqual([{ category: 'style', comments: 1, up: 0, down: 2 }])
    expect(
      (
        await send(
          app,
          'GET',
          '/api/learnings/reactions?repo=work:shop/till',
          undefined,
          as('reader'),
        )
      ).status,
    ).toBe(403)
    expect(
      (await send(app, 'GET', '/api/learnings/reactions', undefined, as('reader'))).status,
    ).toBe(400)
  })
})

const source = (discussionId: string, author: string, repo = 'work:toys/kite') => ({
  repo,
  mergeRequest: 1,
  discussionId,
  noteId: `${discussionId}-${author}`,
  author,
  at: '2026-11-04T09:30:00.000Z',
})

describe('candidate scores', () => {
  test('two replies in one discussion are still one review reply', () => {
    const one = candidate('a', { sources: [source('d1', 'robin'), source('d1', 'lee')] })
    expect(learningSourceKind(one)).toBe('review-reply')
    expect(learningConfidence(one)).toBe(2)
  })

  test('a proposal with replies is merged and its proposer counts as an author', () => {
    const merged = candidate('b', {
      sources: [source('d1', 'robin')],
      proposal: { by: 'mcp:bot', reason: 'seen' },
    })
    expect(learningSourceKind(merged)).toBe('merged')
    expect(learningConfidence(merged)).toBe(2)
  })

  test('confidence tops out at 5', () => {
    const wide = candidate('c', {
      sources: [
        source('d1', 'robin'),
        source('d2', 'lee', 'work:toys/yoyo'),
        source('d3', 'sam', 'work:shop/till'),
        source('d4', 'kim'),
      ],
    })
    expect(learningSourceKind(wide)).toBe('merged')
    expect(learningConfidence(wide)).toBe(5)
  })
})
