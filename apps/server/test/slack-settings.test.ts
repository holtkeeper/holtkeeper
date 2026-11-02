import { beforeEach, describe, expect, test } from 'bun:test'

import type { ExternalAccountView, SlackSettingsView } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { COMMAND_ACTION, type SlackFetch, signSlackRequest } from '@holtkeeper/chat-slack'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { releaseSettingsDefinition } from '@holtkeeper/release'
import { FakeForge } from '@holtkeeper/release/testing'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'

const NOW = new Date('2026-11-03T09:00:00.000Z')
const SECRET = 'panel-signing-secret'
const asAdmin = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'admin' }
const asViewer = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'viewer' }

const auth = headerAuth({
  roles: {
    admin: [
      {
        scope: { all: true },
        actions: ['settings:read', 'settings:write', 'releases:read', 'releases:run'],
      },
    ],
    viewer: [{ scope: { all: true }, actions: ['settings:read'] }],
  },
})

let fake: FakeForge
let store: Store
let app: ReturnType<typeof createApp>
let background: Promise<unknown>[]
let slackCalls: { method: string; body: Record<string, unknown>; auth: string | null }[]

const slackFetch: SlackFetch = async (url, init) => {
  const text = typeof init.body === 'string' ? init.body : '{}'
  const form = new Headers(init.headers).get('content-type')?.startsWith('application/x-www-form')
  const body: Record<string, unknown> = form
    ? Object.fromEntries(new URLSearchParams(text))
    : (JSON.parse(text) as Record<string, unknown>)
  const method = url.split('/').at(-1) ?? ''
  const authorization = new Headers(init.headers).get('authorization')
  slackCalls.push({ method, body, auth: authorization })
  if (method === 'auth.test')
    return Response.json(
      authorization === 'Bearer xoxb-good'
        ? { ok: true, team_id: 'T1', team: 'Acme', user_id: 'UBOT', user: 'holtkeeper' }
        : { ok: false, error: 'invalid_auth' },
    )
  if (method === 'conversations.info')
    return Response.json(
      body['channel'] === 'G9'
        ? {
            ok: true,
            channel: { id: 'G9', name: 'private-team', is_private: true, is_member: true },
          }
        : { ok: false, error: 'channel_not_found' },
    )
  if (method === 'conversations.list')
    return Response.json({
      ok: true,
      channels: [
        { id: 'C2', name: 'releases', is_private: false, is_member: true },
        ...(String(body['types']).includes('private_channel')
          ? [{ id: 'G1', name: 'secret-team', is_private: true, is_member: true }]
          : []),
      ],
    })
  return Response.json({ ok: true, channel: body['channel'], ts: `1.${slackCalls.length}` })
}

beforeEach(() => {
  fake = new FakeForge()
  fake.commitTo('main', 'feat: [ABC-1] first screen')
  fake.tag('v1.0.0')
  background = []
  slackCalls = []
  store = memoryStore()
  const vault = aesVault('v'.repeat(32))
  app = createApp({
    config: parseConfig({
      forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => fake.forge } },
      groups: {
        games: { forge: 'work', include: ['g/*'] },
        tools: { forge: 'work', include: ['t/*'] },
      },
      server: { auth, store, vaultKey: 'v'.repeat(32), publicUrl: 'https://holt.example' },
    }),
    auth,
    store,
    vault,
    credentials: createCredentialService({
      credentials: store.credentials,
      activity: store.activity,
      vault,
    }),
    settings: [...builtinSettings, releaseSettingsDefinition],
    analyses: [],
    now: () => NOW,
    slackFetch,
    onBackground: (work) => void background.push(work),
  })
})

const call = async (method: string, path: string, body?: unknown, headers = asAdmin) => {
  const response = await app.request(`/api${path}`, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json: unknown = await response.json().catch(() => undefined)
  return { status: response.status, body: json }
}

const settings = async () => (await call('GET', '/slack')).body as SlackSettingsView

const connect = () =>
  call('PUT', '/slack/connection', { botToken: 'xoxb-good', signingSecret: SECRET })

const policy = (extra: Record<string, unknown> = {}) => ({
  channels: [
    {
      channel: 'C2',
      name: 'releases',
      scope: { groups: ['games'] },
      actions: ['releases:read'],
      defaultRepo: 'work:g/app',
    },
  ],
  unboundChannels: 'deny',
  directMessages: true,
  ...extra,
})

const fromSlack = async (path: string, body: string) => {
  const timestamp = String(NOW.getTime() / 1000)
  const response = await app.request(`/api/chat/slack/${path}`, {
    method: 'POST',
    headers: {
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signSlackRequest(SECRET, timestamp, body),
    },
    body,
  })
  await Promise.all(background)
  return response.status
}

const slash = (channel: string, text: string) =>
  fromSlack(
    'commands',
    new URLSearchParams({ team_id: 'T1', user_id: 'U1', channel_id: channel, text }).toString(),
  )

const lastPost = () =>
  JSON.stringify(slackCalls.findLast((entry) => entry.method === 'chat.postMessage')?.body ?? {})

const linkFromSlack = async () => {
  await slash('D1', 'link')
  const url = /https:\/\/holt\.example\/accounts\/claim\?token=([\w-]+)/.exec(lastPost())
  if (!url?.[1]) throw new Error(`no link in ${lastPost()}`)
  return url[1]
}

describe('slack settings', () => {
  test('describe the app to create before anything is connected', async () => {
    const view = await settings()
    expect(view.source).toBe('none')
    expect(view.urls.events).toBe('https://holt.example/api/chat/slack/events')
    expect(view.createAppUrl).toStartWith('https://api.slack.com/apps?new_app=1&manifest_json=')
    expect(JSON.stringify(view.manifest)).toContain('https://holt.example/api/chat/slack/commands')
    expect(view.policy).toEqual({ channels: [], unboundChannels: 'deny', directMessages: true })
    expect(await slash('C2', 'help')).toBe(404)
  })

  test('connect with a checked token, sealed, and refuse bad ones', async () => {
    expect(
      (await call('PUT', '/slack/connection', { botToken: 'xoxb-bad', signingSecret: 'x' })).status,
    ).toBe(400)
    expect(
      (await call('PUT', '/slack/connection', { botToken: 'nope', signingSecret: 'x' })).status,
    ).toBe(400)
    expect((await connect()).status).toBe(200)
    expect((await connect()).status).toBe(200)
    const view = await settings()
    expect(view).toMatchObject({
      source: 'panel',
      workspace: { teamId: 'T1', team: 'Acme', bot: 'holtkeeper' },
      connectedBy: expect.stringContaining('jane'),
    })
    expect(JSON.stringify(await store.kv?.get('chat:slack:connection'))).not.toContain('xoxb-good')
    expect((await call('PUT', '/slack/connection', {}, asViewer)).status).toBe(403)
    expect((await call('GET', '/slack/channels')).body).toEqual({
      channels: [
        { id: 'C2', name: 'releases', private: false, member: true },
        { id: 'G1', name: 'secret-team', private: true, member: true },
      ],
    })
  })

  test('save channel policies with default repositories inside their scope', async () => {
    await connect()
    expect((await call('PUT', '/slack/policy', policy())).status).toBe(200)
    expect((await settings()).policy.channels[0]?.defaultRepo).toBe('work:g/app')
    const outside = policy()
    outside.channels[0] = { ...outside.channels[0]!, defaultRepo: 'work:t/cli' }
    expect((await call('PUT', '/slack/policy', outside)).status).toBe(400)
    const byId: { channels: Record<string, unknown>[] } = policy()
    byId.channels.push(
      { channel: 'G9', name: 'G9', scope: { all: true }, actions: ['releases:read'] },
      { channel: 'C77', name: 'C77', scope: { all: true }, actions: [] },
    )
    expect((await call('PUT', '/slack/policy', byId)).status).toBe(200)
    expect((await settings()).policy.channels.map((binding) => binding.name)).toEqual([
      'releases',
      'private-team',
      'C77',
    ])
    await store.kv?.set('chat:slack:policy', {
      ...byId,
      channels: [{ channel: 'G9', name: 'G9', scope: { all: true }, actions: [] }],
    })
    expect((await settings()).policy.channels[0]?.name).toBe('private-team')
    expect(JSON.stringify(await store.kv?.get('chat:slack:policy'))).toContain('private-team')
    const twice = policy()
    twice.channels.push(twice.channels[0]!)
    expect((await call('PUT', '/slack/policy', twice)).status).toBe(400)
  })
})

describe('slack channels', () => {
  beforeEach(async () => {
    await connect()
    await call('PUT', '/slack/policy', policy())
  })

  test('refuse channels that are not connected and direct messages when off', async () => {
    await slash('C9', 'help')
    expect(lastPost()).toContain('This channel is not connected to Holtkeeper')
    expect(lastPost()).toContain('C9')
    await call('PUT', '/slack/policy', policy({ directMessages: false }))
    await slash('D1', 'help')
    expect(lastPost()).toContain('Commands in direct messages are off')
  })

  test('link from a direct message, once, as a verified account', async () => {
    await slash('C2', 'link')
    expect(lastPost()).toContain('direct message')
    const token = await linkFromSlack()
    const claimed = await call('POST', '/accounts/claim', { token })
    expect(claimed.status).toBe(201)
    expect(claimed.body).toMatchObject({
      provider: 'slack:T1',
      externalId: 'U1',
      verification: 'challenge',
    } satisfies Partial<ExternalAccountView>)
    expect((await call('POST', '/accounts/claim', { token })).status).toBe(410)
  })

  test('narrow what people can do to the channel and use its default repository', async () => {
    await call('POST', '/accounts/claim', { token: await linkFromSlack() })

    await slash('C2', 'release')
    expect(lastPost()).toContain('Release · g/app')
    expect(lastPost()).not.toContain(COMMAND_ACTION)

    await slash('C2', 'release repo=work:t/cli')
    expect(lastPost()).toContain('This conversation may not do this here')

    await slash('C2', 'release propose')
    expect(lastPost()).toContain('`releases:run`')

    await slash('D1', 'release repo=work:g/app')
    expect(lastPost()).toContain('Release · g/app')
  })
})
