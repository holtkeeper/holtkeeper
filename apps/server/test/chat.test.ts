import { beforeEach, describe, expect, test } from 'bun:test'

import type { ChatConversation } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { releaseSettingsDefinition } from '@holtkeeper/release'
import { FakeForge } from '@holtkeeper/release/testing'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'

const asAdmin = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'admin' }
const asViewer = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'viewer' }

let fake: FakeForge
let store: Store
let app: ReturnType<typeof createApp>
let background: Promise<unknown>[]

beforeEach(async () => {
  fake = new FakeForge()
  fake.commitTo('main', 'feat: [ABC-1] first screen')
  fake.tag('v1.0.0')
  fake.commitTo('development', 'feat: [ABC-2] statistics')
  background = []
  store = memoryStore()
  const vault = aesVault('v'.repeat(32))
  app = createApp({
    config: parseConfig({
      forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => fake.forge } },
      groups: { games: { forge: 'work', include: ['g/app'] } },
    }),
    auth: headerAuth({
      roles: {
        admin: [{ scope: { all: true }, actions: ['releases:read', 'releases:run'] }],
        viewer: [{ scope: { all: true }, actions: ['releases:read'] }],
      },
    }),
    store,
    vault,
    credentials: createCredentialService({
      credentials: store.credentials,
      activity: store.activity,
      vault,
    }),
    settings: [...builtinSettings, releaseSettingsDefinition],
    analyses: [],
    now: () => new Date('2026-11-01T09:00:00.000Z'),
    releasePollMs: 1,
    onBackground: (work) => void background.push(work),
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

const send = async (text: string, headers = asAdmin, repo: string | undefined = 'work:g/app') => {
  const response = await app.request('/api/chat/messages', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ text, ...(repo && { repo }) }),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as ChatConversation
}

const conversation = async (headers = asAdmin) =>
  (await (await app.request('/api/chat/messages', { headers })).json()) as ChatConversation

describe('panel chat', () => {
  test('answers commands with cards, with or without the prefix', async () => {
    const first = await send('release')
    expect(first.messages.map((message) => message.from)).toEqual(['user', 'holtkeeper'])
    expect(first.messages[0]).toMatchObject({ text: 'release', repo: 'work:g/app' })
    expect(first.messages[1]?.card?.title).toBe('Release · g/app')
    expect(first.commands.map((command) => command.name)).toEqual(['release', 'help'])

    const second = await send('/holtkeeper help', asAdmin, undefined)
    expect(second.messages.at(-1)?.card?.title).toBe('Holtkeeper commands')
    expect((await conversation(asViewer)).messages).toEqual([])
  })

  test('checks actions against the person and follows deploys in place', async () => {
    expect(
      (await send('release deploy preprod tag=v1.0.0 --yes', asViewer)).messages.at(-1)?.card
        ?.title,
    ).toBe('Not allowed')

    fake.addPipeline('v1.0.0', 'manual', [{ name: 'deploy:preprod', status: 'manual' }])
    const started = await send('release deploy preprod tag=v1.0.0 --yes')
    const card = started.messages.at(-1)
    expect(card?.card?.title).toBe('Deploy v1.0.0 · g/app')
    fake.jobs.get(1)![0]!.status = 'success'
    await Promise.all(background)
    const after = (await conversation()).messages.find((message) => message.id === card?.id)
    expect(after?.updatedAt).toBeDefined()
    expect(JSON.stringify(after?.card)).toContain('"status":"done"')
  })

  test('forgets the conversation and refuses anonymous callers', async () => {
    await send('help')
    const cleared = await app.request('/api/chat/messages', { method: 'DELETE', headers: asAdmin })
    expect(cleared.status).toBe(204)
    expect((await conversation()).messages).toEqual([])
    expect((await app.request('/api/chat/messages')).status).toBe(401)
  })
})
