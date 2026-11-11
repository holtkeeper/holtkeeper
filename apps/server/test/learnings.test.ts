import { beforeEach, describe, expect, test } from 'bun:test'

import type { Agent, AgentTask } from '@holtkeeper/agent'
import type { LearningCandidate, LearningList, ReactionTotalsList } from '@holtkeeper/api'
import type { AuthProvider } from '@holtkeeper/auth'
import { headerAuth } from '@holtkeeper/auth-header'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import type { Discussion, GitForge, NoteReaction } from '@holtkeeper/forge'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { z } from 'zod'

import { createApp } from '../src/app.ts'
import type { ServerDeps } from '../src/context.ts'
import { createEventDispatcher } from '../src/events.ts'

let store: Store
let discussions: Discussion[]
let reactions: Map<string, NoteReaction[]>
let mergeRequestReads: number
let discussionReads: number

const fakeForge = {
  kind: 'gitlab',
  listDiscussions: async () => {
    discussionReads++
    return discussions
  },
  listNoteReactions: async (_repo: string, _id: number, noteId: number | string) =>
    reactions.get(String(noteId)) ?? [],
  getMergeRequest: async (_repo: string, id: number) => {
    mergeRequestReads++
    return { id, webUrl: `https://forge.test/toys/kite/-/merge_requests/${id}`, headSha: 'h' }
  },
} as unknown as GitForge

const config = parseConfig({
  forges: { work: { kind: 'gitlab', url: 'https://forge.test', create: () => fakeForge } },
  groups: {
    toys: { forge: 'work', include: ['toys/*'] },
    shop: { forge: 'work', include: ['shop/*'] },
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
const setup = (auth: AuthProvider = noAuth()) =>
  createApp({
    config,
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
    reader: [{ scope: { groups: ['toys'] }, actions: ['knowledge:read'] }],
    member: [{ scope: { groups: ['toys'] }, actions: ['knowledge:read', 'knowledge:write'] }],
    lead: [
      {
        scope: { groups: ['toys'] },
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
      candidate('c2', { repo: 'work:shop/till', key: 'other', suggestedScope: 'group' }),
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
    expect(lead.candidates[0]?.scopes).toEqual(['repo:work:toys/kite', 'group:toys'])
    const reader = (await (
      await send(app, 'GET', '/api/learnings', undefined, as('reader'))
    ).json()) as LearningList
    expect(reader.candidates.map((c) => [c.id, c.canDecide, c.scopes])).toEqual([['c1', false, []]])
    expect(
      (await send(app, 'GET', '/api/learnings?status=maybe', undefined, as('reader'))).status,
    ).toBe(400)
  })

  test('accepting puts the rule into the Guide; group scopes need settings:write', async () => {
    const app = setup(teams)
    expect((await send(app, 'POST', '/api/learnings/c1/accept', {}, as('reader'))).status).toBe(403)
    expect(
      (await send(app, 'POST', '/api/learnings/c1/accept', { scope: 'group:toys' }, as('member')))
        .status,
    ).toBe(403)
    expect(
      (await send(app, 'POST', '/api/learnings/c1/accept', { scope: 'group:shop' }, as('lead')))
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

  test('accepting a group suggestion without a group in the repository needs a scope', async () => {
    await store.learnings.put(
      candidate('c3', { repo: 'work:lonely/one', key: 'k3', suggestedScope: 'group' }),
    )
    const app = setup()
    expect((await send(app, 'POST', '/api/learnings/c3/accept', {})).status).toBe(400)
    expect((await send(app, 'POST', '/api/learnings/c2/accept', {})).status).toBe(200)
    expect((await store.guides.get('group:shop', 'review'))?.learnings).toHaveLength(1)
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
