import { beforeEach, describe, expect, test } from 'bun:test'

import type { Principal } from '@holtkeeper/access'
import { headerAuth } from '@holtkeeper/auth-header'
import { COMMAND_ACTION, type SlackFetch, signSlackRequest } from '@holtkeeper/chat-slack'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { createIdentities } from '@holtkeeper/identities'
import { releaseSettingsDefinition } from '@holtkeeper/release'
import { FakeForge } from '@holtkeeper/release/testing'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'

const NOW = new Date('2026-11-01T09:00:00.000Z')
const SECRET = 'signing-secret'

let fake: FakeForge
let store: Store
let app: ReturnType<typeof createApp>
let background: Promise<unknown>[]
let slackCalls: { method: string; body: Record<string, unknown> }[]

const slackFetch: SlackFetch = async (url, init) => {
  const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<
    string,
    unknown
  >
  slackCalls.push({ method: url.split('/').at(-1) ?? '', body })
  return Response.json({ ok: true, channel: body['channel'], ts: `1.${slackCalls.length}` })
}

beforeEach(async () => {
  fake = new FakeForge()
  fake.commitTo('main', 'feat: [ABC-1] first screen')
  fake.tag('v1.0.0')
  fake.commitTo('development', 'feat: [ABC-2] statistics')
  background = []
  slackCalls = []
  store = memoryStore()
  const vault = aesVault('v'.repeat(32))
  app = createApp({
    config: parseConfig({
      forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => fake.forge } },
      groups: { games: { forge: 'work', include: ['g/app'] } },
      chat: { slack: { botToken: 'xoxb-test', signingSecret: SECRET } },
    }),
    auth: headerAuth({ roles: {} }),
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
    releasePollMs: 1,
    slackFetch,
    onBackground: (work) => void background.push(work),
  })
  await store.kv?.set('chat:slack:policy', {
    channels: [
      {
        channel: 'C1',
        name: 'releases',
        scope: { all: true },
        actions: ['releases:read', 'releases:run'],
      },
    ],
    unboundChannels: 'deny',
    directMessages: true,
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

const send = async (path: string, body: string, secret = SECRET) => {
  const timestamp = String(NOW.getTime() / 1000)
  const response = await app.request(`/api/chat/slack/${path}`, {
    method: 'POST',
    headers: {
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signSlackRequest(secret, timestamp, body),
    },
    body,
  })
  await Promise.all(background)
  return response
}

const slash = (text: string) =>
  send(
    'commands',
    new URLSearchParams({ team_id: 'T1', user_id: 'U1', channel_id: 'C1', text }).toString(),
  )

const click = (value: string) =>
  send(
    'interactions',
    new URLSearchParams({
      payload: JSON.stringify({
        type: 'block_actions',
        team: { id: 'T1' },
        user: { id: 'U1' },
        channel: { id: 'C1' },
        message: { ts: '1.1' },
        actions: [{ action_id: `${COMMAND_ACTION}:0`, value }],
      }),
    }).toString(),
  )

const linkSlackUser = async () => {
  const accounts = store.externalAccounts
  if (!accounts) throw new Error('the memory store keeps external accounts')
  const identities = createIdentities({ accounts, now: () => new Date() })
  const jane: Principal = {
    id: 'jane',
    name: 'jane',
    provider: 'header',
    grants: [{ scope: { all: true }, actions: ['releases:read', 'releases:run'] }],
  }
  const linked = await identities.link(jane, { provider: 'slack:T1', externalId: 'U1' })
  const { code } = await identities.issueChallenge(jane, linked.id)
  await identities.completeChallenge({ provider: 'slack:T1', externalId: 'U1', code })
}

const posted = (index = -1) => JSON.stringify(slackCalls.at(index)?.body ?? {})

describe('slack routes', () => {
  test('refuse unsigned requests and answer the URL check', async () => {
    expect((await send('commands', 'text=help', 'wrong')).status).toBe(401)
    const check = await send(
      'events',
      JSON.stringify({ type: 'url_verification', challenge: 'c1' }),
    )
    expect(await check.json()).toEqual({ challenge: 'c1' })
    expect(slackCalls).toEqual([])
  })

  test('tell unlinked people how to link their account', async () => {
    expect((await slash('release repo=work:g/app')).status).toBe(200)
    expect(slackCalls[0]?.method).toBe('chat.postMessage')
    expect(posted()).toContain('Send me `link` in a direct message')
  })

  test('show the release state and deploy from a button, updating the message', async () => {
    await linkSlackUser()
    await slash('release repo=work:g/app')
    expect(posted()).toContain('Release · g/app')
    expect(posted()).toContain('"value":"release propose repo=work:g/app"')

    fake.addPipeline('v1.0.0', 'manual', [{ name: 'deploy:preprod', status: 'manual' }])
    await click('release deploy preprod repo=work:g/app')
    expect(posted()).toContain('"value":"release deploy preprod tag=v1.0.0 --yes repo=work:g/app"')
    expect(slackCalls.at(-1)?.body['thread_ts']).toBe('1.1')

    await click('release deploy preprod tag=v1.0.0 --yes repo=work:g/app')
    const deployMessage = slackCalls.length
    expect(posted()).toContain('🔄 <https://forge/j/100|preprod>')
    fake.jobs.get(1)![0]!.status = 'success'
    await Promise.all(background)
    const update = slackCalls.at(-1)
    expect(update?.method).toBe('chat.update')
    expect(update?.body['ts']).toBe(`1.${deployMessage}`)
    expect(JSON.stringify(update?.body)).toContain('✅ <https://forge/j/100|preprod>')
  })
})
