import { beforeEach, describe, expect, test } from 'bun:test'

import type { RepoTarget } from '@holtkeeper/access'
import {
  type Agent,
  type AgentResult,
  type AgentTask,
  BudgetExceededError,
  createTranscript,
} from '@holtkeeper/agent'
import { BudgetDeniedError } from '@holtkeeper/ai-usage'
import type {
  AgentTranscriptView,
  ChatMessageList,
  ChatPeopleView,
  ChatPostResult,
  ChatThreadList,
  ChatThreadView,
  ChatUnreadView,
} from '@holtkeeper/api'
import { type ArtifactStore, memoryArtifactStore } from '@holtkeeper/artifacts'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { releaseSettingsDefinition } from '@holtkeeper/release'
import { FakeForge } from '@holtkeeper/release/testing'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { withServerDefaults } from '../src/agent.ts'
import { createApp } from '../src/app.ts'
import type { ChatAgentRun } from '../src/chat-threads.ts'
import { storeTranscript } from '../src/transcripts.ts'

const person = (user: string, groups: string, name: string, email: string) => ({
  'x-forwarded-user': user,
  'x-forwarded-groups': groups,
  'x-forwarded-preferred-username': name,
  'x-forwarded-email': email,
})
const asAdmin = person('jane', 'admin', 'Jane Quill', 'jane.quill@example.test')
const asMember = person('omar', 'games', 'Omar Vale', 'omar.vale@example.test')
const asOutsider = person('lena', 'puzzles', 'Lena Frost', 'lena.frost@example.test')
const asNobody = person('ivo', 'none', 'Ivo Penn', 'ivo.penn@example.test')

interface AgentCall {
  target: RepoTarget
  run: ChatAgentRun
  task: AgentTask
}

let fake: FakeForge
let store: Store
let app: ReturnType<typeof createApp>
let background: Promise<unknown>[]
let artifacts: ArtifactStore
let calls: AgentCall[]
let respond: (task: AgentTask) => Promise<AgentResult> | AgentResult
let withAgent: boolean
let serverDefaults: boolean
let minute: number

const now = () => new Date(Date.UTC(2026, 10, 1, 9, minute))

beforeEach(async () => {
  fake = new FakeForge()
  fake.commitTo('main', 'feat: [ABC-1] first screen')
  fake.tag('v1.0.0')
  fake.commitTo('development', 'feat: [ABC-2] statistics')
  background = []
  calls = []
  minute = 0
  withAgent = true
  serverDefaults = false
  respond = () => ({ text: 'Here is what I found.', turns: 2, costUsd: 0.05 })
  store = memoryStore()
  artifacts = memoryArtifactStore()
  const vault = aesVault('v'.repeat(32))
  app = createApp({
    artifacts,
    config: parseConfig({
      forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => fake.forge } },
      groups: {
        games: { forge: 'work', include: ['g/**'] },
        puzzles: { forge: 'work', include: ['p/**'] },
      },
    }),
    auth: headerAuth({
      roles: {
        admin: [{ scope: { all: true }, actions: ['repos:read', 'releases:read', 'releases:run'] }],
        games: [{ scope: { groups: ['games'] }, actions: ['repos:read', 'releases:read'] }],
        puzzles: [{ scope: { groups: ['puzzles'] }, actions: ['repos:read'] }],
        none: [{ scope: { all: true }, actions: ['audit:read'] }],
      },
    }),
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: [...builtinSettings, releaseSettingsDefinition],
    analyses: [],
    now: () => {
      minute += 1
      return now()
    },
    releasePollMs: 1,
    onBackground: (work) => void background.push(work),
    chatAgentFor: async (target, run) => {
      if (!withAgent) return undefined
      const agent: Agent = {
        name: 'fake',
        run: async <Output>(task: AgentTask<Output>) => {
          calls.push({ target, run, task })
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fake answers text only
          return (await respond(task)) as AgentResult<Output>
        },
      }
      if (!serverDefaults) return agent
      return withServerDefaults(agent, {
        repo: target,
        store,
        now,
        artifacts,
        origin: { actor: run.actor, interactive: true },
        requester: run.requester,
      })
    },
  })
  await store.settings.put({
    id: 'releases',
    key: 'releases',
    scope: { all: true },
    value: { deploy: { environments: [{ name: 'preprod', job: 'deploy:preprod' }] } },
    secret: false,
    updatedAt: '2026-10-01T00:00:00.000Z',
  })
})

const call = async (
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
) =>
  app.request(`/api${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined && { 'content-type': 'application/json' }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })

const json = async <T>(response: Response, status = 200): Promise<T> => {
  expect(response.status).toBe(status)
  return (await response.json()) as T
}

const createThread = async (body: Record<string, unknown>, headers = asAdmin) =>
  json<ChatThreadView>(await call('POST', '/chat/threads', headers, body), 201)

const settle = async () => {
  // oxlint-disable-next-line no-await-in-loop -- work may queue more work
  while (background.length) await background.shift()
}

const post = async (id: string, body: string, headers = asAdmin, repo?: string) => {
  const result = await json<ChatPostResult>(
    await call('POST', `/chat/threads/${id}/messages`, headers, { body, ...(repo && { repo }) }),
  )
  if (result.replying) await settle()
  return result
}

const putUser = (id: string, name: string, groups: string[], extra = {}) =>
  store.users.putUser({
    id,
    name,
    grants: [{ scope: { groups }, actions: ['repos:read'] }],
    disabled: false,
    sessionVersion: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...extra,
  })

const messages = async (id: string, headers = asAdmin, query = '') =>
  json<ChatMessageList>(await call('GET', `/chat/threads/${id}/messages${query}`, headers))

describe('team chat threads', () => {
  test('creates, lists, renames and archives threads; scope decides who sees them', async () => {
    const team = await createThread({ title: 'Planning' })
    const games = await createThread({ title: 'Games release', group: 'games' }, asMember)
    const repo = await createThread({ title: 'Arcade', repo: 'work:g/app', autoReply: true })
    const puzzles = await createThread({ title: 'Puzzles', repo: 'work:p/box' })
    expect(team).toMatchObject({ title: 'Planning', archived: false, autoReply: false, unread: 0 })
    expect(team.participants).toEqual([
      { id: 'header:jane', label: 'Participant A', avatarUrl: '/api/avatars/header%3Ajane.svg' },
    ])

    const titles = async (headers: Record<string, string>) =>
      (await json<ChatThreadList>(await call('GET', '/chat/threads', headers))).threads.map(
        (thread) => thread.title,
      )
    expect(await titles(asAdmin)).toEqual(['Puzzles', 'Arcade', 'Games release', 'Planning'])
    expect(await titles(asMember)).toEqual(['Arcade', 'Games release', 'Planning'])
    expect(await titles(asOutsider)).toEqual(['Puzzles', 'Planning'])
    expect((await call('GET', '/chat/threads', asNobody)).status).toBe(403)

    expect((await call('GET', `/chat/threads/${repo.id}`, asOutsider)).status).toBe(404)
    expect((await call('GET', `/chat/threads/${games.id}/messages`, asOutsider)).status).toBe(404)
    expect(
      (await call('POST', `/chat/threads/${puzzles.id}/messages`, asMember, { body: 'hi' })).status,
    ).toBe(404)
    expect(
      (await call('POST', '/chat/threads', asMember, { title: 'x', repo: 'work:p/box' })).status,
    ).toBe(403)
    expect(
      (await call('POST', '/chat/threads', asAdmin, { title: 'x', group: 'nope' })).status,
    ).toBe(400)

    const renamed = await json<ChatThreadView>(
      await call('PATCH', `/chat/threads/${team.id}`, asMember, {
        title: 'Roadmap',
        archived: true,
      }),
    )
    expect(renamed).toMatchObject({ title: 'Roadmap', archived: true })
    expect(await titles(asAdmin)).not.toContain('Roadmap')
    const archived = await json<ChatThreadList>(
      await call('GET', '/chat/threads?archived=true', asAdmin),
    )
    expect(archived.threads.map((thread) => thread.title)).toEqual(['Roadmap'])
    expect(
      (await call('POST', `/chat/threads/${team.id}/messages`, asAdmin, { body: 'hi' })).status,
    ).toBe(409)
  })

  test('slash commands answer with cards in the thread and deploy cards change in place', async () => {
    const thread = await createThread({ title: 'Arcade', repo: 'work:g/app' })
    const first = await post(thread.id, '/release')
    expect(first.replying).toBe(false)
    const page = await messages(thread.id)
    expect(page.messages.map((message) => message.authorType)).toEqual(['human', 'system'])
    expect(page.messages[1]?.card?.title).toBe('Release · g/app')
    expect(
      (await json<ChatThreadList>(await call('GET', '/chat/threads', asAdmin))).commands.map(
        (command) => command.name,
      ),
    ).toEqual(['release', 'help'])

    fake.addPipeline('v1.0.0', 'manual', [{ name: 'deploy:preprod', status: 'manual' }])
    await post(thread.id, '/release deploy preprod tag=v1.0.0 --yes')
    const deploy = (await messages(thread.id)).messages.at(-1)
    expect(deploy?.card?.title).toBe('Deploy v1.0.0 · g/app')
    const since = (await messages(thread.id)).serverTime
    fake.jobs.get(1)![0]!.status = 'success'
    await settle()
    const poll = await messages(thread.id, asAdmin, `?after=${deploy?.seq}&changedSince=${since}`)
    expect(poll.messages.map((message) => message.id)).toEqual([deploy!.id])
    expect(poll.messages[0]?.updatedAt).toBeDefined()
    expect(JSON.stringify(poll.messages[0]?.card)).toContain('"status":"done"')
    expect(calls).toEqual([])
  })

  test('the agent replies to @holtkeeper mentions or with autoReply, as interactive work of the asker', async () => {
    const thread = await createThread({ title: 'Arcade', repo: 'work:g/app' })
    expect((await post(thread.id, 'Just talking among ourselves.')).replying).toBe(false)
    expect(calls).toEqual([])

    respond = async (task) => {
      const transcript = createTranscript()
      transcript.write({
        type: 'assistant',
        toolCalls: [
          { id: '1', name: 'mcp__holtkeeper__search_knowledge', input: {} },
          { id: '2', name: 'mcp__holtkeeper__search_knowledge', input: {} },
          { id: '3', name: 'package_usage', input: {} },
        ],
      })
      const transcriptRef = await storeTranscript(artifacts, transcript, {
        repo: 'work:g/app',
        taskKind: 'chat',
      })
      const chat = task.toolsets?.find((toolset) => toolset.name === 'chat')
      await chat?.tools[0]?.run(
        {
          repos: ['work:g/app', 'work:g/lib'],
          title: 'Rename the widget prop',
          summary: 'Rename the widget prop.',
        },
        { dir: task.dir, signal: new AbortController().signal },
      )
      return { text: 'Use the shared widget. [kb:3]', turns: 3, costUsd: 0.07, transcriptRef }
    }
    const asked = await post(thread.id, '@Holtkeeper which widget should we use?', asMember)
    expect(asked.replying).toBe(true)
    expect(asked.message.mentions).toEqual(['holtkeeper'])

    expect(calls).toHaveLength(1)
    const [reply] = calls
    expect(reply?.run).toMatchObject({
      actor: 'header:omar',
      interactive: true,
      requester: { id: 'header:omar' },
    })
    expect(reply?.target).toMatchObject({ forge: 'work', path: 'g/app', groups: ['games'] })
    expect(reply?.task).toMatchObject({
      tier: 'main',
      maxTurns: 12,
      maxCostUsd: 0.4,
      taskKind: 'chat',
      capabilities: [],
    })
    const page = await messages(thread.id)
    const answer = page.messages.find((message) => message.authorType === 'agent' && message.body)
    expect(answer).toMatchObject({
      body: 'Use the shared widget. [kb:3]',
      costUsd: 0.07,
      toolTrace: [
        { tool: 'search_knowledge', calls: 2 },
        { tool: 'package_usage', calls: 1 },
      ],
    })
    const card = page.messages.at(-1)?.card
    const [group] = await store.tasks.listGroups()
    expect(group).toMatchObject({
      kind: 'chat',
      title: 'Rename the widget prop',
      proposedBy: 'header:omar',
      source: { type: 'chat', threadId: thread.id, messageId: page.messages.at(-1)?.id },
    })
    expect(card?.blocks).toEqual([
      {
        type: 'task',
        repos: ['work:g/app', 'work:g/lib'],
        summary: 'Rename the widget prop.',
        status: 'proposed',
        groupId: group!.id,
        budgetUsd: 3,
      },
    ])
    expect(page.thread.replying).toBe(false)

    const transcript = await json<AgentTranscriptView>(
      await call('GET', `/chat/messages/${answer?.id}/transcript`, asMember),
    )
    expect(transcript.lines[0]).toMatchObject({ type: 'assistant' })
    expect((await call('GET', `/chat/messages/${answer?.id}/transcript`, asOutsider)).status).toBe(
      404,
    )

    await json(await call('PATCH', `/chat/threads/${thread.id}`, asAdmin, { autoReply: true }))
    await post(thread.id, 'And for the menu?')
    expect(calls).toHaveLength(2)
    expect(calls[1]?.run.actor).toBe('header:jane')
  })

  test('agent replies through the server defaults keep the transcript and its tool trace', async () => {
    serverDefaults = true
    respond = (task) => {
      task.transcript?.write({
        type: 'assistant',
        text: 'Looking it up.',
        toolCalls: [{ id: '1', name: 'mcp__holtkeeper__search_symbols', input: {} }],
      })
      task.transcript?.write({ type: 'tool-result', id: '1', output: 'WidgetBase' })
      return { text: 'WidgetBase is the shared base.', turns: 2, costUsd: 0.03 }
    }
    const thread = await createThread({ title: 'Arcade', repo: 'work:g/app' })
    await post(thread.id, '@holtkeeper which base class?', asMember)

    expect(calls[0]?.task.transcript).toBeDefined()
    const answer = (await messages(thread.id)).messages.find(
      (message) => message.authorType === 'agent',
    )
    expect(answer).toMatchObject({
      body: 'WidgetBase is the shared base.',
      toolTrace: [{ tool: 'search_symbols', calls: 1 }],
    })
    expect(answer?.transcriptRef).toBeString()
    const transcript = await json<AgentTranscriptView>(
      await call('GET', `/chat/messages/${answer?.id}/transcript`, asMember),
    )
    expect(transcript.ref).toBe(answer?.transcriptRef ?? '')
    expect(transcript.lines.map((line) => line.type)).toEqual(['assistant', 'tool-result'])
  })

  test('team-wide threads refuse slash commands; repository and group threads run them', async () => {
    const team = await createThread({ title: 'Team' })
    const refused = await call('POST', `/chat/threads/${team.id}/messages`, asAdmin, {
      body: '/release',
      repo: 'work:g/app',
    })
    expect(refused.status).toBe(400)
    expect(await refused.text()).toContain('repository or group thread')
    expect((await messages(team.id)).messages).toEqual([])

    const games = await createThread({ title: 'Games', group: 'games' })
    await post(games.id, '/release', asAdmin, 'work:g/app')
    expect((await messages(games.id)).messages.at(-1)?.card?.title).toBe('Release · g/app')
  })

  test('group and unscoped threads reply on stand-in targets', async () => {
    const games = await createThread({ title: 'Games', group: 'games', autoReply: true })
    const team = await createThread({ title: 'Team', autoReply: true })
    await post(games.id, 'Hello?')
    await post(team.id, 'Hello?')
    expect(calls.map((entry) => entry.target)).toEqual([
      { forge: 'chat', path: 'group/games', groups: ['games'] },
      { forge: 'chat', path: 'team', groups: [] },
    ])
  })

  test('the model sees participant labels, never names, emails or user ids', async () => {
    await store.users.putUser({
      id: 'header:omar',
      name: 'Omar Vale',
      email: 'omar.vale@example.test',
      grants: [],
      disabled: false,
      sessionVersion: 1,
      createdAt: '2026-10-01T00:00:00.000Z',
    })
    const thread = await createThread({ title: 'Arcade', repo: 'work:g/app' })
    await post(thread.id, 'Omar, can you check this? Mail me at jane.quill@example.test')
    await post(
      thread.id,
      'Sure Jane Quill, @omar here. Ping omar.vale@example.test or header:omar.',
      asMember,
    )
    await post(thread.id, '@holtkeeper what did Omar Vale and jane decide?')

    const prompt = calls[0]?.task.prompt ?? ''
    expect(prompt).toContain('Participant A: Participant B, can you check this?')
    expect(prompt).toContain('Participant B: Sure Participant A, @Participant B here.')
    expect(prompt).toContain(
      'Participant A: @holtkeeper what did Participant B and Participant A decide?',
    )
    for (const leak of ['Omar', 'omar', 'Jane', 'jane', 'Quill', 'Vale', 'example.test', 'header:'])
      expect(prompt).not.toContain(leak)
    expect(calls[0]?.task.system).not.toContain('Jane')

    const view = await json<ChatThreadView>(
      await call('GET', `/chat/threads/${thread.id}`, asAdmin),
    )
    expect(view.participants.map((participant) => [participant.label, participant.name])).toEqual([
      ['Participant A', 'Jane Quill'],
      ['Participant B', 'Omar Vale'],
    ])
    const page = await messages(thread.id)
    expect(page.messages[1]?.authorLabel).toBe('Participant B')
  })

  test('header sign-in posters without accounts are scrubbed from the prompt too', async () => {
    const thread = await createThread({ title: 'Team' })
    await post(thread.id, 'Omar Vale joins us today, write to omar.vale@example.test.')
    await post(thread.id, 'Hi all, Omar here. Lena Frost asked me about the grid.', asMember)
    await post(thread.id, 'Lena here: yes, ping lena.frost@example.test or Frost.', asOutsider)
    await post(thread.id, '@holtkeeper what did omar and Lena decide about the grid?')

    const stored = await store.chat.getThread(thread.id)
    expect(stored?.people).toEqual([
      { id: 'header:jane', name: 'Jane Quill', email: 'jane.quill@example.test' },
      { id: 'header:omar', name: 'Omar Vale', email: 'omar.vale@example.test' },
      { id: 'header:lena', name: 'Lena Frost', email: 'lena.frost@example.test' },
    ])
    const prompt = calls[0]?.task.prompt ?? ''
    expect(prompt).toContain('Participant A: Participant B joins us today, write to Participant B.')
    expect(prompt).toContain(
      'Participant C: Participant C here: yes, ping Participant C or Participant C.',
    )
    for (const leak of [
      'Omar',
      'omar',
      'Vale',
      'Lena',
      'lena',
      'Frost',
      'Jane',
      'Quill',
      'example.test',
      'header:',
    ])
      expect(prompt).not.toContain(leak)
    const view = await json<ChatThreadView>(
      await call('GET', `/chat/threads/${thread.id}`, asAdmin),
    )
    expect(view.participants.map((participant) => participant.name)).toEqual([
      'Jane Quill',
      'Omar Vale',
      'Lena Frost',
    ])
  })

  test('a long history is summarized on the fast tier once, then reused', async () => {
    const thread = await createThread({ title: 'Arcade', repo: 'work:g/app' })
    const long = 'The widget grid needs a calmer layout. '.repeat(160)
    for (let index = 0; index < 18; index++)
      // oxlint-disable-next-line no-await-in-loop -- messages keep their order
      await post(thread.id, `${index}: ${long}`, index % 2 ? asMember : asAdmin)
    respond = (task) =>
      task.taskKind === 'chat-summary'
        ? {
            text: 'Participant A and Participant B argued about the grid.',
            turns: 1,
            costUsd: 0.001,
          }
        : { text: 'Noted.', turns: 1, costUsd: 0.02 }

    await post(thread.id, '@holtkeeper sum it up')
    expect(calls.map((entry) => [entry.task.taskKind, entry.task.tier])).toEqual([
      ['chat-summary', 'fast'],
      ['chat', 'main'],
    ])
    expect(calls[0]?.task).toMatchObject({ capabilities: [], maxTurns: 1 })
    expect(calls[0]?.run.interactive).toBe(true)
    const summarized = await store.chat.getThread(thread.id)
    expect(summarized?.summary?.text).toBe('Participant A and Participant B argued about the grid.')
    const prompt = calls[1]?.task.prompt ?? ''
    expect(prompt).toStartWith('Summary of the earlier conversation:')
    expect(prompt).not.toContain('Participant A: 0: ')

    await post(thread.id, '@holtkeeper and now?')
    expect(calls.map((entry) => entry.task.taskKind)).toEqual(['chat-summary', 'chat', 'chat'])
    expect((await store.chat.getThread(thread.id))?.summary).toEqual(summarized?.summary)
  })

  test('replies that cannot run leave a system notice', async () => {
    const thread = await createThread({ title: 'Arcade', repo: 'work:g/app', autoReply: true })
    withAgent = false
    await post(thread.id, 'Anyone?')
    respond = () => {
      throw new BudgetDeniedError([])
    }
    withAgent = true
    await post(thread.id, 'Anyone now?')
    respond = () => {
      throw new BudgetExceededError('cap', { costUsd: 0.4 })
    }
    await post(thread.id, 'And now?')
    const notices = (await messages(thread.id)).messages
      .filter((message) => message.authorType === 'system')
      .map((message) => message.body)
    expect(notices).toEqual([
      'No AI provider is configured, so Holtkeeper cannot reply here.',
      'The weekly AI budget is used up, so Holtkeeper cannot reply until it resets.',
      'The reply stopped at its $0.40 cap. Ask a narrower question.',
    ])
  })

  test('unread counts follow read markers; own messages are read', async () => {
    const thread = await createThread({ title: 'Arcade', repo: 'work:g/app' })
    await post(thread.id, 'One', asMember)
    const second = await post(thread.id, 'Two', asMember)
    await post(thread.id, 'Mine')
    const unread = async (headers: Record<string, string>) =>
      json<ChatUnreadView>(await call('GET', '/chat/unread', headers))
    expect(await unread(asAdmin)).toEqual({ threads: {}, total: 0 })
    expect(await unread(asMember)).toEqual({ threads: { [thread.id]: 1 }, total: 1 })

    const fresh = await createThread({ title: 'Team' }, asMember)
    await post(fresh.id, 'Hello all', asMember)
    expect(await unread(asAdmin)).toEqual({ threads: { [fresh.id]: 1 }, total: 1 })
    expect(
      (
        await call('POST', `/chat/threads/${fresh.id}/read`, asAdmin, {
          messageId: second.message.id,
        })
      ).status,
    ).toBe(204)
    expect((await unread(asAdmin)).total).toBe(1)
    const last = (await messages(fresh.id)).messages.at(-1)
    await call('POST', `/chat/threads/${fresh.id}/read`, asAdmin, { messageId: last?.id })
    expect(await unread(asAdmin)).toEqual({ threads: {}, total: 0 })
  })

  test('pages older messages with before and reports whether more exist', async () => {
    const thread = await createThread({ title: 'Arcade', repo: 'work:g/app' })
    for (let index = 0; index < 5; index++)
      // oxlint-disable-next-line no-await-in-loop -- messages keep their order
      await post(thread.id, `m${index}`)
    const newest = await messages(thread.id, asAdmin, '?limit=2')
    expect(newest.messages.map((message) => message.body)).toEqual(['m3', 'm4'])
    expect(newest.hasMore).toBe(true)
    const older = await messages(thread.id, asAdmin, `?limit=5&before=${newest.messages[0]?.seq}`)
    expect(older.messages.map((message) => message.body)).toEqual(['m0', 'm1', 'm2'])
    expect(older.hasMore).toBe(false)
    expect((await call('GET', `/chat/threads/${thread.id}/messages?after=x`, asAdmin)).status).toBe(
      400,
    )
  })

  test('lists the groups a caller may open threads in and the people a thread can mention', async () => {
    await putUser('u1', 'Rita Moss', ['games'], { email: 'rita.moss@example.test' })
    await putUser('u2', 'Tom Reed', ['games'])
    await putUser('u3', 'Pia Lund', ['puzzles'])
    await putUser('u4', 'Max Hale', ['games'], { disabled: true })

    const list = async (headers: Record<string, string>) =>
      json<ChatThreadList>(await call('GET', '/chat/threads', headers))
    expect((await list(asAdmin)).groups).toEqual(['games', 'puzzles'])
    expect((await list(asMember)).groups).toEqual(['games'])

    const thread = await createThread({ title: 'Arcade', repo: 'work:g/app' })
    expect(thread.groups).toEqual(['games'])
    const people = await json<ChatPeopleView>(
      await call('GET', `/chat/threads/${thread.id}/people`, asAdmin),
    )
    expect(people.people.map((entry) => [entry.handle, entry.name])).toEqual([
      ['rita.moss', 'Rita Moss'],
      ['tomreed', 'Tom Reed'],
    ])
    expect((await call('GET', `/chat/threads/${thread.id}/people`, asOutsider)).status).toBe(404)

    await post(thread.id, 'ping @rita.moss and @tomreed, not @pialund or @maxhale')
    const view = await json<ChatThreadView>(
      await call('GET', `/chat/threads/${thread.id}`, asAdmin),
    )
    expect(view.participants.map((participant) => participant.id)).toEqual([
      'header:jane',
      'u1',
      'u2',
    ])

    const outside = await call('POST', `/chat/threads/${thread.id}/messages`, asAdmin, {
      body: '/release',
      repo: 'work:p/game',
    })
    expect(outside.status).toBe(400)
  })
})
