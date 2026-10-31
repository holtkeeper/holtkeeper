import { beforeEach, describe, expect, test } from 'bun:test'

import type {
  ConfigEntryDetail,
  ConfigEntryList,
  ForgeWebhookResult,
  SchedulePreview,
} from '@holtkeeper/api'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import type { GitForge, WebhookSpec, WebhookTarget } from '@holtkeeper/forge'
import { type ConfigSource, createConfigSource, liveConfig } from '@holtkeeper/managed-config'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'
import { defaultWebhookTargets } from '../src/routes/config.ts'

const vault = aesVault('v'.repeat(32))
const fileForge = { kind: 'gitlab', url: 'https://file.test', create: () => ({}) as GitForge }
const file = parseConfig({
  forges: { work: fileForge },
  groups: { games: { forge: 'work', include: ['games/*'] } },
  jobs: { schedules: [{ name: 'nightly', cron: '0 3 * * *', analyzers: ['depgraph'] }] },
})

let store: Store
let source: ConfigSource
let credentialId: string
let registrations: { target: WebhookTarget; hook: WebhookSpec }[]
let removed: unknown[]

const cloudForge = {
  kind: 'gitlab',
  async ensureWebhook(target: WebhookTarget, hook: WebhookSpec) {
    registrations.push({ target, hook })
    const hooks = target.group
      ? [
          { id: '11', scope: 'project' as const, target: `${target.group}/a` },
          { id: '12', scope: 'project' as const, target: `${target.group}/b` },
        ]
      : [{ id: '13', scope: 'project' as const, target: target.project ?? '' }]
    return {
      id: hooks[0]?.id ?? '',
      hooks,
      ...(target.group && { fallback: `project hooks for ${target.group}` }),
    }
  },
  async removeWebhook(hooks: unknown[]) {
    removed.push(...hooks)
  },
} as unknown as GitForge

let app: ReturnType<typeof createApp>

beforeEach(async () => {
  store = memoryStore()
  registrations = []
  removed = []
  const credentials = createCredentialService({
    credentials: store.credentials,
    activity: store.activity,
    vault,
  })
  credentialId = (
    await credentials.create(
      {
        name: 'cloud',
        kind: 'gitlab',
        url: 'https://gitlab.com',
        scope: { all: true },
        secret: 'tok',
      },
      'root',
    )
  ).id
  if (!store.config) throw new Error('memory store has config')
  source = await createConfigSource({
    file,
    store: store.config,
    forgeFactories: {
      gitlab: (doc) => ({ kind: 'gitlab', url: doc.data.url, create: () => cloudForge }),
    },
    revealToken: (id) => credentials.reveal(id),
    openSecret: (sealed) => vault.open(sealed),
  })
  app = createApp({
    config: liveConfig(source),
    configSource: source,
    auth: noAuth(),
    store,
    vault,
    credentials,
    settings: builtinSettings,
    analyses: [],
    analyzers: [],
    now: () => new Date('2026-10-30T12:00:00.000Z'),
  })
})

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })

const putForge = () =>
  call('PUT', '/config/forges/cloud', { kind: 'gitlab', url: 'https://gitlab.com', credentialId })

describe('config routes', () => {
  test('CRUD with provenance, validation, history and activity', async () => {
    expect(
      (
        await call('PUT', '/config/forges/cloud', {
          kind: 'gitlab',
          url: 'https://gitlab.com',
          credentialId: 'nope',
        })
      ).status,
    ).toBe(400)
    expect((await putForge()).status).toBe(200)
    expect(
      (await call('PUT', '/config/groups/apps', { forge: 'missing', include: ['apps/*'] })).status,
    ).toBe(400)
    const group = await call('PUT', '/config/groups/games', {
      forge: 'cloud',
      include: ['studio/*'],
    })
    expect(group.status).toBe(200)
    expect(await group.json()).toMatchObject({ id: 'games', provenance: 'file+panel', version: 1 })
    await call('PUT', '/config/groups/games', { forge: 'cloud', include: ['studio/*', 'web/*'] })

    const groups = (await (await call('GET', '/config/groups')).json()) as ConfigEntryList<'group'>
    expect(groups.entries.map((e) => [e.id, e.provenance, e.data.include])).toEqual([
      ['games', 'file+panel', ['studio/*', 'web/*']],
    ])
    const forges = (await (await call('GET', '/config/forges')).json()) as ConfigEntryList<'forge'>
    expect(forges.entries.map((e) => `${e.id}:${e.provenance}`)).toEqual([
      'work:file',
      'cloud:panel',
    ])
    const detail = (await (
      await call('GET', '/config/groups/games')
    ).json()) as ConfigEntryDetail<'group'>
    expect(detail.history.map((h) => h.data.include)).toEqual([['studio/*']])
    expect(source.current().groups.games?.forge).toBe('cloud')

    expect((await call('DELETE', '/config/forges/cloud')).status).toBe(409)
    expect((await call('DELETE', '/config/groups/games')).status).toBe(204)
    expect(source.current().groups.games?.forge).toBe('work')
    expect((await call('DELETE', '/config/groups/games')).status).toBe(404)
    expect((await call('GET', '/config/nope')).status).toBe(404)

    const actions = (await store.activity.list()).map((e) => `${e.action} ${e.subject}`)
    expect(actions).toContain('config.forge.created forge:cloud')
    expect(actions).toContain('config.group.updated group:games')
    expect(actions).toContain('config.group.removed group:games')
  })

  test('schedules, previews and triggers', async () => {
    const put = await call('PUT', '/config/schedules/office', {
      name: 'Office hours',
      every: '1h',
      timezone: 'UTC',
      windows: { allow: [{ days: ['fri'], from: '13:00', to: '15:00' }] },
      analyzers: ['quality'],
    })
    expect(put.status).toBe(200)
    const preview = (await (
      await call('GET', '/schedules/office/preview?count=3')
    ).json()) as SchedulePreview
    expect(preview).toEqual({
      id: 'office',
      timezone: 'UTC',
      runs: ['2026-10-30T13:00:00.000Z', '2026-10-30T14:00:00.000Z', '2026-11-06T13:00:00.000Z'],
    })
    expect((await call('GET', '/schedules/nightly/preview?count=1')).status).toBe(200)
    expect((await call('GET', '/schedules/none/preview')).status).toBe(404)
    expect(
      (
        await call('PUT', '/config/schedules/bad', {
          name: 'x',
          analyzers: ['a'],
          cron: '0 3 * * *',
          every: '1h',
        })
      ).status,
    ).toBe(400)

    expect(
      (await call('PUT', '/config/triggers/tag', { on: 'label', label: 'x', analyzers: ['port'] }))
        .status,
    ).toBe(400)
    expect(
      (
        await call('PUT', '/config/triggers/label:x', {
          on: 'label',
          label: 'x',
          analyzers: ['port'],
        })
      ).status,
    ).toBe(200)
    expect(source.current().jobs?.onLabel).toEqual({ x: ['port'] })
    const triggers = (await (
      await call('GET', '/config/triggers')
    ).json()) as ConfigEntryList<'trigger'>
    expect(triggers.entries).toMatchObject([{ id: 'label:x', provenance: 'panel' }])

    const exported = await call('GET', '/config/export')
    expect(exported.headers.get('content-type')).toContain('typescript')
    const text = await exported.text()
    expect(text).toContain("every: '1h'")
    expect(text).toContain("x: ['port']")
  })

  test('webhook secret: generate, register, receive, rotate', async () => {
    await putForge()
    await call('PUT', '/config/groups/studio', {
      forge: 'cloud',
      include: ['studio/*', 'tools/cli'],
    })
    await call('PUT', '/config/triggers/tag', { on: 'tag', analyzers: ['changelog'] })
    expect((await call('POST', '/forges/work/webhook', {})).status).toBe(409)

    const created = await call(
      'POST',
      '/forges/cloud/webhook',
      { register: true },
      { host: 'hk.test' },
    )
    expect(created.status).toBe(201)
    const result = (await created.json()) as ForgeWebhookResult
    expect(result.url).toBe('http://localhost/api/webhooks/cloud')
    expect(result.secret).toMatch(/^[\w-]{43}$/)
    expect(registrations.map((r) => r.target)).toEqual([
      { group: 'studio' },
      { project: 'tools/cli' },
    ])
    expect(registrations[0]?.hook.events).toEqual([
      'push',
      'tag_push',
      'merge_request',
      'note',
      'pipeline',
    ])
    expect(result.registered.map((h) => h.target)).toEqual(['studio/a', 'studio/b', 'tools/cli'])
    expect(result.notes).toEqual(['project hooks for studio'])

    const tagPush = (secret: string) =>
      call(
        'POST',
        '/webhooks/cloud',
        {
          object_kind: 'tag_push',
          ref: 'refs/tags/v1.0.0',
          after: 'a'.repeat(40),
          project: { path_with_namespace: 'studio/a', web_url: 'https://gitlab.com/studio/a' },
        },
        { 'x-gitlab-token': secret, 'x-gitlab-event': 'Tag Push Hook' },
      )
    expect((await tagPush('wrong')).status).toBe(401)
    expect((await tagPush(result.secret)).status).toBe(202)
    expect(
      (await store.jobs.list()).map((j) => `${j.analyzer} ${j.repo.forge}:${j.repo.path} ${j.ref}`),
    ).toEqual(['changelog cloud:studio/a v1.0.0'])
    expect((await call('POST', '/webhooks/work', {})).status).toBe(404)

    registrations = []
    const rotated = (await (
      await call('POST', '/forges/cloud/webhook', {})
    ).json()) as ForgeWebhookResult
    expect(rotated.secret).not.toBe(result.secret)
    expect(registrations.map((r) => r.target)).toEqual([
      { project: 'studio/a' },
      { project: 'studio/b' },
      { project: 'tools/cli' },
    ])
    expect((await tagPush(result.secret)).status).toBe(401)
    const forgeDoc = await store.config?.get('forge', 'cloud')
    expect(forgeDoc?.data.webhook?.secret).not.toContain(rotated.secret)
    expect(JSON.stringify(await (await call('GET', '/config/forges')).json())).not.toContain(
      rotated.secret,
    )

    await call('DELETE', '/config/groups/studio')
    await call('DELETE', '/config/triggers/tag')
    expect((await call('DELETE', '/config/forges/cloud')).status).toBe(204)
    expect(removed).toHaveLength(3)
    const actions = (await store.activity.list()).map((e) => e.action)
    expect(actions).toContain('config.forge.webhook_created')
    expect(actions).toContain('config.forge.webhook_rotated')
  })

  test('defaultWebhookTargets', () => {
    expect(defaultWebhookTargets(file, 'work')).toEqual([{ group: 'games' }])
  })
})
