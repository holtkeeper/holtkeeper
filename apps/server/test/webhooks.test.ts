import { beforeEach, describe, expect, test } from 'bun:test'

import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import type { Discussion, GitForge } from '@holtkeeper/forge'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { z } from 'zod'

import { createApp } from '../src/app.ts'
import type { JobAnalyzerInfo } from '../src/context.ts'
import { commandOptions, parseCommand } from '../src/events.ts'

const HEAD = 'c'.repeat(40)

let store: Store
let discussions: Discussion[]
let notes: { discussionId?: string; body: string }[]

const fakeForge = {
  kind: 'gitlab',
  listDiscussions: async () => discussions,
  replyToDiscussion: async (_r: string, _id: number, discussionId: string, body: string) => {
    notes.push({ discussionId, body })
  },
  commentOnMergeRequest: async (_r: string, _id: number, body: string) => {
    notes.push({ body })
  },
} as unknown as GitForge

const config = parseConfig({
  forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => fakeForge } },
  groups: {
    games: { forge: 'work', include: ['games/*'] },
    tools: { forge: 'work', include: ['tools/*'] },
  },
  jobs: {
    webhookSecret: 'hook-secret',
    botUsername: 'holtkeeper',
    onMergeRequest: { analyzers: ['review', 'fleet'], groups: ['games'] },
    onLabel: { 'needs-port': ['port'], 'deep-review': ['review'] },
    commands: {
      review: { analyzer: 'review' },
      port: { analyzer: 'port', args: ['targets'] },
    },
  },
})

const analyzers: JobAnalyzerInfo[] = [
  {
    kind: 'review',
    scope: 'repo',
    options: z.object({
      mergeRequest: z.coerce.number(),
      mode: z.enum(['auto', 'full', 'incremental']).optional(),
      replyTo: z.string().optional(),
    }),
  },
  {
    kind: 'port',
    scope: 'repo',
    options: z.object({
      mergeRequest: z.coerce.number(),
      targets: z.union([z.string(), z.array(z.string())]),
    }),
  },
  { kind: 'fleet', scope: 'group', options: z.object({}) },
]

const setup = () => {
  const vault = aesVault('v'.repeat(32))
  return createApp({
    config,
    auth: noAuth(),
    store,
    vault,
    credentials: createCredentialService({
      credentials: store.credentials,
      activity: store.activity,
      vault,
    }),
    settings: builtinSettings,
    analyses: [],
    analyzers,
    now: () => new Date('2026-10-30T12:00:00.000Z'),
  })
}

const hook = (event: string, body: unknown) =>
  setup().request('/api/webhooks/gitlab', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-gitlab-token': 'hook-secret',
      'x-gitlab-event': event,
    },
    body: JSON.stringify(body),
  })

const project = (path = 'games/a') => ({
  id: 1,
  name: path.split('/')[1],
  path_with_namespace: path,
  web_url: `https://gitlab.test/${path}`,
})

/** Shaped after GitLab's documented "Merge request events" payload. */
const mergeRequestEvent = (
  attributes: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  object_kind: 'merge_request',
  event_type: 'merge_request',
  user: { id: 2, name: 'Jane', username: 'jane' },
  project: project(),
  object_attributes: {
    id: 99,
    iid: 7,
    title: 'Add pricing',
    state: 'opened',
    draft: false,
    work_in_progress: false,
    last_commit: { id: HEAD, message: 'feat: price', author: { name: 'Jane' } },
    ...attributes,
  },
  labels: [],
  changes: {},
  ...extra,
})

/** Shaped after GitLab's documented "Comment on a merge request" payload. */
const noteEvent = (note: string, attributes: Record<string, unknown> = {}, user = 'jane') => ({
  object_kind: 'note',
  event_type: 'note',
  user: { id: 2, name: user, username: user },
  project: project(),
  object_attributes: {
    id: 1244,
    note,
    noteable_type: 'MergeRequest',
    discussion_id: 'disc-1',
    type: null,
    ...attributes,
  },
  merge_request: { id: 99, iid: 7, state: 'opened', last_commit: { id: HEAD } },
})

const jobs = async () =>
  (await store.jobs.list()).map((j) => ({
    analyzer: j.analyzer,
    ref: j.ref,
    options: j.options,
    trigger: j.trigger,
  }))

const ignored = async (response: Response) => {
  expect(response.status).toBe(200)
  return ((await response.json()) as { ignored: string }).ignored
}

beforeEach(() => {
  store = memoryStore()
  discussions = []
  notes = []
})

describe('parsing commands', () => {
  test('parseCommand finds the first command line', () => {
    expect(parseCommand('Please\n/holtkeeper port web  api\nthanks')).toEqual({
      name: 'port',
      args: ['web', 'api'],
    })
    expect(parseCommand('/holtkeeper review')).toEqual({ name: 'review', args: [] })
    expect(parseCommand('see /holtkeeper review')).toBeUndefined()
  })

  test('commandOptions maps positional and key=value arguments', () => {
    expect(commandOptions(['web'], ['targets'])).toEqual({ targets: 'web' })
    expect(commandOptions(['web', 'api', 'mode=full'], ['targets'])).toEqual({
      targets: ['web', 'api'],
      mode: 'full',
    })
    expect(commandOptions(['a', 'b'], ['first', 'second'])).toEqual({ first: 'a', second: 'b' })
    expect(commandOptions(['stray'])).toEqual({})
  })
})

describe('merge request events', () => {
  test('open queues repo analyzers with the merge request and head', async () => {
    const response = await hook('Merge Request Hook', mergeRequestEvent({ action: 'open' }))
    expect(response.status).toBe(202)
    expect(await jobs()).toEqual([
      { analyzer: 'review', ref: HEAD, options: { mergeRequest: 7 }, trigger: 'webhook' },
    ])
    await hook('Merge Request Hook', mergeRequestEvent({ action: 'reopen' }))
    expect(await jobs()).toHaveLength(1)
    expect((await store.activity.list())[0]?.action).toBe('job.merge_request')
  })

  test('update runs only with new commits or when leaving draft', async () => {
    expect(
      await ignored(await hook('Merge Request Hook', mergeRequestEvent({ action: 'update' }))),
    ).toContain('no new commits')
    await hook(
      'Merge Request Hook',
      mergeRequestEvent({ action: 'update', oldrev: 'a'.repeat(40) }),
    )
    expect(await jobs()).toHaveLength(1)

    store = memoryStore()
    await hook(
      'Merge Request Hook',
      mergeRequestEvent(
        { action: 'update' },
        { changes: { draft: { previous: true, current: false } } },
      ),
    )
    expect(await jobs()).toHaveLength(1)
  })

  test('skips drafts, closed merge requests, bot events and other groups', async () => {
    expect(
      await ignored(
        await hook('Merge Request Hook', mergeRequestEvent({ action: 'open', draft: true })),
      ),
    ).toContain('draft')
    expect(
      await ignored(
        await hook('Merge Request Hook', mergeRequestEvent({ action: 'close', state: 'closed' })),
      ),
    ).toContain('closed')
    expect(
      await ignored(
        await hook('Merge Request Hook', {
          ...mergeRequestEvent({ action: 'open' }),
          user: { username: 'holtkeeper' },
        }),
      ),
    ).toContain('bot')
    expect(
      await ignored(
        await hook('Merge Request Hook', {
          ...mergeRequestEvent({ action: 'open' }),
          project: project('tools/x'),
        }),
      ),
    ).toContain('onMergeRequest.groups')
    expect((await hook('Merge Request Hook', { object_kind: 'merge_request' })).status).toBe(400)
    expect(await jobs()).toEqual([])
  })

  test('added labels queue onLabel analyzers', async () => {
    await hook(
      'Merge Request Hook',
      mergeRequestEvent(
        { action: 'update' },
        {
          changes: {
            labels: {
              previous: [{ id: 1, title: 'bug' }],
              current: [
                { id: 1, title: 'bug' },
                { id: 2, title: 'needs-port' },
              ],
            },
          },
        },
      ),
    )
    expect((await jobs()).map((j) => j.analyzer)).toEqual(['port'])
  })
})

describe('note events', () => {
  test('a command queues its analyzer with positional options and acknowledges', async () => {
    const response = await hook('Note Hook', noteEvent('/holtkeeper port web api'))
    expect(response.status).toBe(202)
    expect(await jobs()).toEqual([
      {
        analyzer: 'port',
        ref: HEAD,
        options: { mergeRequest: 7, targets: ['web', 'api'] },
        trigger: 'webhook',
      },
    ])
    expect(notes[0]?.body).toContain('Queued `port`')
    expect(notes[0]?.body).toContain('holtkeeper:review')
    expect((await store.activity.list())[0]?.action).toBe('job.command')
  })

  test('review command with options; unknown and invalid commands are answered', async () => {
    await hook('Note Hook', noteEvent('/holtkeeper review mode=full'))
    expect((await jobs())[0]?.options).toEqual({ mergeRequest: 7, mode: 'full' })

    expect(await ignored(await hook('Note Hook', noteEvent('/holtkeeper deploy')))).toContain(
      'unknown command',
    )
    expect(notes.at(-1)?.body).toContain('Available: `review`, `port`')
    expect(
      await ignored(await hook('Note Hook', noteEvent('/holtkeeper review mode=fast'))),
    ).toContain('invalid')
    expect(notes.at(-1)?.body).toContain('Could not run')
    expect(await jobs()).toHaveLength(1)
  })

  test('a reply in our thread queues a reply job', async () => {
    discussions = [
      {
        id: 'disc-1',
        resolvable: true,
        resolved: false,
        notes: [
          {
            id: 1,
            author: 'holtkeeper',
            body: 'Bug <!-- holtkeeper:review id=x -->',
            createdAt: '',
            system: false,
          },
          { id: 2, author: 'jane', body: 'Why?', createdAt: '', system: false },
        ],
      },
    ]
    const response = await hook('Note Hook', noteEvent('Why?', { type: 'DiffNote' }))
    expect(response.status).toBe(202)
    expect(await jobs()).toEqual([
      {
        analyzer: 'review',
        ref: HEAD,
        options: { mergeRequest: 7, replyTo: 'disc-1' },
        trigger: 'webhook',
      },
    ])
  })

  test('ignores other threads, plain comments and our own notes', async () => {
    discussions = [
      {
        id: 'disc-1',
        resolvable: true,
        resolved: false,
        notes: [
          { id: 1, author: 'bob', body: 'Hm', createdAt: '', system: false },
          { id: 2, author: 'jane', body: 'Yes', createdAt: '', system: false },
        ],
      },
    ]
    expect(
      await ignored(await hook('Note Hook', noteEvent('Yes', { type: 'DiffNote' }))),
    ).toContain('not started by Holtkeeper')
    expect(await ignored(await hook('Note Hook', noteEvent('LGTM')))).toContain('not a reply')
    expect(
      await ignored(await hook('Note Hook', noteEvent('/holtkeeper review', {}, 'holtkeeper'))),
    ).toContain('bot')
    expect(
      await ignored(
        await hook(
          'Note Hook',
          noteEvent('Still applies <!-- holtkeeper:review reply -->', { type: 'DiffNote' }),
        ),
      ),
    ).toContain('bot')
    expect(
      await ignored(
        await hook('Note Hook', {
          ...noteEvent('x'),
          object_attributes: { ...noteEvent('x').object_attributes, noteable_type: 'Issue' },
        }),
      ),
    ).toContain('not on a merge request')
    expect(await jobs()).toEqual([])
  })
})
