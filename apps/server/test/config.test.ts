import { beforeEach, describe, expect, test } from 'bun:test'

import type {
  ConfigEntryDetail,
  ConfigEntryList,
  ForgeRepositoryList,
  ForgeWebhookResult,
  RepoAccessView,
  SchedulePreview,
} from '@holtkeeper/api'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig, parseConfigFile } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import {
  type GitForge,
  type WebhookSpec,
  type WebhookTarget,
  webhookEvents,
} from '@holtkeeper/forge'
import { type ConfigSource, createConfigSource, liveConfig } from '@holtkeeper/managed-config'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { z } from 'zod'

import { createApp } from '../src/app.ts'
import { defaultWebhookTargets } from '../src/routes/config.ts'

const vault = aesVault('v'.repeat(32))
const file = parseConfigFile({}, { warn: () => {} })

let store: Store
let source: ConfigSource
let credentialId: string
let registrations: { target: WebhookTarget; hook: WebhookSpec }[]
let removed: unknown[]

const forgeError = (status: number) => Object.assign(new Error(`${status} failed`), { status })

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
  async getCurrentUser() {
    return { username: 'holtkeeper-bot', name: 'Holtkeeper' }
  },
  async getRepository(path: string) {
    if (path === 'hidden/app') throw forgeError(404)
    if (path === 'locked/app') throw forgeError(403)
    if (path === 'flaky/app') throw new Error('socket hang up')
    return {
      path,
      name: path.split('/').at(-1),
      defaultBranch: 'main',
      webUrl: `https://gitlab.com/${path}`,
      cloneUrl: `https://gitlab.com/${path}.git`,
      archived: path === 'old/app',
    }
  },
  async listMemberRepositories(query: { search?: string; limit?: number } = {}) {
    return ['studio/game', 'tools/cli']
      .filter((path) => !query.search || path.includes(query.search))
      .slice(0, query.limit)
      .map((path) => ({
        path,
        name: path.split('/').at(-1),
        defaultBranch: 'main',
        webUrl: `https://gitlab.com/${path}`,
        cloneUrl: `https://gitlab.com/${path}.git`,
        archived: false,
      }))
  },
} as unknown as GitForge

let app: ReturnType<typeof createApp>

beforeEach(async () => {
  store = memoryStore()
  registrations = []
  removed = []
  const credentials = createCredentialService({
    credentials: store.credentials,
    vault,
  })
  credentialId = (
    await credentials.create({
      name: 'cloud',
      kind: 'gitlab',
      url: 'https://gitlab.com',
      scope: { all: true },
      secret: 'tok',
    })
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
    analyzers: [{ kind: 'snapshot', scope: 'repo', options: z.object({}) }],
    now: () => new Date('2026-10-30T12:00:00.000Z'),
  })
})

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })

const putForge = (body: Record<string, unknown> = {}) =>
  call('PUT', '/config/forges/cloud', {
    kind: 'gitlab',
    url: 'https://gitlab.com',
    credentialId,
    ...body,
  })

describe('config routes', () => {
  test('CRUD with validation, history and audit', async () => {
    expect(
      (
        await call('PUT', '/config/forges/cloud', {
          kind: 'gitlab',
          url: 'https://gitlab.com',
          credentialId: 'nope',
        })
      ).status,
    ).toBe(400)
    expect((await putForge({ botUsername: 'keeper' })).status).toBe(200)
    expect(source.current().jobs.botUsernames).toEqual({ cloud: 'keeper' })
    expect(
      (await call('PUT', '/config/groups/apps', { forge: 'missing', include: ['apps/*'] })).status,
    ).toBe(400)
    const group = await call('PUT', '/config/groups/games', {
      forge: 'cloud',
      include: ['studio/*'],
    })
    expect(group.status).toBe(200)
    expect(await group.json()).toMatchObject({ id: 'games', version: 1 })
    await call('PUT', '/config/groups/games', { forge: 'cloud', include: ['studio/*', 'web/*'] })

    const groups = (await (await call('GET', '/config/groups')).json()) as ConfigEntryList<'group'>
    expect(groups.entries.map((e) => [e.id, e.version, e.data.include])).toEqual([
      ['games', 2, ['studio/*', 'web/*']],
    ])
    const forges = (await (await call('GET', '/config/forges')).json()) as ConfigEntryList<'forge'>
    expect(forges.entries.map((e) => [e.id, e.data.botUsername])).toEqual([['cloud', 'keeper']])
    const detail = (await (
      await call('GET', '/config/groups/games')
    ).json()) as ConfigEntryDetail<'group'>
    expect(detail.history.map((h) => h.data.include)).toEqual([['studio/*']])
    expect(source.current().groups.games?.forge).toBe('cloud')

    expect((await call('DELETE', '/config/forges/cloud')).status).toBe(409)
    expect((await call('DELETE', '/config/groups/games')).status).toBe(204)
    expect(source.current().groups.games).toBeUndefined()
    expect((await call('DELETE', '/config/groups/games')).status).toBe(404)
    expect((await call('GET', '/config/nope')).status).toBe(404)

    const actions = (await store.audit.list({ limit: 500 })).events.map(
      (e) => `${e.action} ${e.target.type}:${e.target.id}`,
    )
    expect(actions).toContain('forge.create forge:cloud')
    expect(actions).toContain('group.update group:games')
    expect(actions).toContain('group.delete group:games')
  })

  test('schedules, previews and triggers', async () => {
    const put = await call('PUT', '/config/schedules/office', {
      name: 'Office hours',
      every: '1h',
      timezone: 'UTC',
      windows: { allow: [{ days: ['fri'], from: '13:00', to: '15:00' }] },
      analyzers: ['snapshot'],
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
      (
        await call('PUT', '/config/triggers/tag', {
          on: 'label',
          label: 'x',
          analyzers: ['snapshot'],
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await call('PUT', '/config/triggers/label:x', {
          on: 'label',
          label: 'x',
          analyzers: ['snapshot'],
        })
      ).status,
    ).toBe(200)
    expect(source.current().jobs?.onLabel).toEqual({ x: ['snapshot'] })
    const triggers = (await (
      await call('GET', '/config/triggers')
    ).json()) as ConfigEntryList<'trigger'>
    expect(triggers.entries).toMatchObject([{ id: 'label:x', version: 1 }])
  })

  test('webhook secret: generate, register, receive, rotate', async () => {
    await putForge()
    await call('PUT', '/config/groups/studio', {
      forge: 'cloud',
      include: ['studio/*', 'tools/cli'],
    })
    await call('PUT', '/config/triggers/tag', { on: 'tag', analyzers: ['snapshot'] })
    expect((await call('POST', '/forges/work/webhook', {})).status).toBe(404)

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
    expect(registrations[0]?.hook.events).toEqual([...webhookEvents])
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
    ).toEqual(['snapshot cloud:studio/a v1.0.0'])
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
    const actions = (await store.audit.list({ limit: 500 })).events.map((e) => e.action)
    expect(actions).toContain('forge.webhook_create')
    expect(actions).toContain('forge.webhook_rotate')
  })

  test('member repositories of a forge', async () => {
    await putForge()
    const response = await call('GET', '/forges/cloud/repositories?search=tools&limit=5')
    expect(response.status).toBe(200)
    expect(((await response.json()) as ForgeRepositoryList).entries).toEqual([
      { path: 'tools/cli', name: 'cli', webUrl: 'https://gitlab.com/tools/cli' },
    ])
    expect((await call('GET', '/forges/missing/repositories')).status).toBe(409)
  })

  test('access to a repository before it is added', async () => {
    await putForge()
    const check = async (path: string) =>
      (await (
        await call('GET', `/forges/cloud/repositories/access?path=${encodeURIComponent(path)}`)
      ).json()) as RepoAccessView
    const account = { username: 'holtkeeper-bot', name: 'Holtkeeper' }
    expect(await check('studio/game')).toEqual({
      status: 'ok',
      account,
      repository: { path: 'studio/game', name: 'game', webUrl: 'https://gitlab.com/studio/game' },
    })
    expect(await check('hidden/app')).toMatchObject({ status: 'not-found', account })
    expect(await check('locked/app')).toMatchObject({ status: 'forbidden' })
    expect(await check('old/app')).toMatchObject({ status: 'archived' })
    expect(await check('flaky/app')).toMatchObject({ status: 'error', message: 'socket hang up' })
    expect((await call('GET', '/forges/cloud/repositories/access')).status).toBe(400)
  })

  test('defaultWebhookTargets', () => {
    const config = parseConfig({
      forges: {
        work: { kind: 'gitlab', url: 'https://work.test', create: () => ({}) as GitForge },
      },
      groups: { games: { forge: 'work', include: ['games/*'] } },
    })
    expect(defaultWebhookTargets(config, 'work')).toEqual([{ group: 'games' }])
  })
})
