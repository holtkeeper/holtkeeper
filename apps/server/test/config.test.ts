import { beforeEach, describe, expect, test } from 'bun:test'

import type {
  ConfigEntryDetail,
  ConfigEntryList,
  ForgeRepositoryList,
  ForgeWebhookResult,
  RepoAccessBatch,
  SchedulePreview,
} from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
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
    expect((await call('PUT', '/config/teams/apps', { owns: ['**/apps'] })).status).toBe(400)
    expect((await call('PUT', '/config/teams/Apps', { owns: ['apps/*'] })).status).toBe(400)
    const team = await call('PUT', '/config/teams/games', { owns: ['cloud:studio/*'] })
    expect(team.status).toBe(200)
    expect(await team.json()).toMatchObject({ id: 'games', version: 1 })
    expect(
      (await call('PUT', '/config/teams/games', { title: ' ', owns: ['cloud:a/*'] })).status,
    ).toBe(400)
    await call('PUT', '/config/teams/games', {
      title: '  Game studio ',
      owns: ['cloud:studio/*', 'cloud:web/*'],
    })

    const teams = (await (await call('GET', '/config/teams')).json()) as ConfigEntryList<'team'>
    expect(teams.entries.map((e) => [e.id, e.version, e.data.owns, e.data.title])).toEqual([
      ['games', 2, ['cloud:studio/*', 'cloud:web/*'], 'Game studio'],
    ])
    expect(source.current().teams.games?.title).toBe('Game studio')
    const forges = (await (await call('GET', '/config/forges')).json()) as ConfigEntryList<'forge'>
    expect(forges.entries.map((e) => [e.id, e.data.botUsername])).toEqual([['cloud', 'keeper']])
    const detail = (await (
      await call('GET', '/config/teams/games')
    ).json()) as ConfigEntryDetail<'team'>
    expect(detail.history.map((h) => h.data.owns)).toEqual([['cloud:studio/*']])
    expect(source.current().teams.games?.owns).toEqual(['cloud:studio/*', 'cloud:web/*'])

    expect((await call('DELETE', '/config/forges/cloud')).status).toBe(409)
    expect((await call('DELETE', '/config/teams/games')).status).toBe(204)
    expect(source.current().teams.games).toBeUndefined()
    expect((await call('DELETE', '/config/teams/games')).status).toBe(404)
    expect((await call('GET', '/config/nope')).status).toBe(404)

    const actions = (await store.audit.list({ limit: 500 })).events.map(
      (e) => `${e.action} ${e.target.type}:${e.target.id}`,
    )
    expect(actions).toContain('forge.create forge:cloud')
    expect(actions).toContain('team.update team:games')
    expect(actions).toContain('team.delete team:games')
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
    await call('PUT', '/config/teams/studio', { owns: ['cloud:studio/*', 'cloud:tools/cli'] })
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

    await call('DELETE', '/config/teams/studio')
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

  test('access before adding: one result per distinct path in order, the account once', async () => {
    await putForge()
    const response = await call('POST', '/forges/cloud/repositories/access', {
      paths: [
        ' studio/game ',
        'hidden/app',
        '',
        'studio/game',
        'locked/app',
        'old/app',
        'flaky/app',
      ],
    })
    expect(response.status).toBe(200)
    expect((await response.json()) as RepoAccessBatch).toEqual({
      account: { username: 'holtkeeper-bot', name: 'Holtkeeper' },
      results: [
        {
          path: 'studio/game',
          status: 'ok',
          repository: {
            path: 'studio/game',
            name: 'game',
            webUrl: 'https://gitlab.com/studio/game',
          },
        },
        { path: 'hidden/app', status: 'not-found', message: '404 failed' },
        { path: 'locked/app', status: 'forbidden', message: '403 failed' },
        {
          path: 'old/app',
          status: 'archived',
          repository: { path: 'old/app', name: 'app', webUrl: 'https://gitlab.com/old/app' },
        },
        { path: 'flaky/app', status: 'error', message: 'socket hang up' },
      ],
    })
    const many = Array.from({ length: 51 }, (_, index) => `team/app-${index}`)
    expect((await call('POST', '/forges/cloud/repositories/access', { paths: many })).status).toBe(
      400,
    )
    expect(
      (await call('POST', '/forges/cloud/repositories/access', { paths: many.slice(0, 50) }))
        .status,
    ).toBe(200)
    expect((await call('POST', '/forges/cloud/repositories/access', { paths: [] })).status).toBe(
      400,
    )
    expect((await call('POST', '/forges/cloud/repositories/access', { paths: [' '] })).status).toBe(
      400,
    )
  })

  test('adding repositories and creating teams need settings:write over everything', async () => {
    await putForge()
    const narrow = createApp({
      config: liveConfig(source),
      configSource: source,
      auth: headerAuth({
        roles: {
          lead: [{ scope: { teams: ['games'] }, actions: ['settings:read', 'settings:write'] }],
        },
      }),
      store,
      vault,
      credentials: createCredentialService({ credentials: store.credentials, vault }),
      settings: builtinSettings,
      analyses: [],
      now: () => new Date('2026-10-30T12:00:00.000Z'),
    })
    const lead = (method: string, path: string, body?: unknown) =>
      narrow.request(`/api${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-forwarded-user': 'lead',
          'x-forwarded-groups': 'lead',
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      })
    expect(
      (await lead('POST', '/forges/cloud/repositories/access', { paths: ['studio/game'] })).status,
    ).toBe(403)
    expect((await lead('GET', '/forges/cloud/repositories')).status).toBe(403)
    expect((await lead('PUT', '/config/teams/games', { owns: ['cloud:studio/*'] })).status).toBe(
      403,
    )
    expect(source.current().teams.games).toBeUndefined()
  })

  test('defaultWebhookTargets', () => {
    const config = parseConfig({
      forges: {
        work: { kind: 'gitlab', url: 'https://work.test', create: () => ({}) as GitForge },
      },
      teams: { games: { owns: ['work:games/*'] } },
    })
    expect(defaultWebhookTargets(config, 'work')).toEqual([{ group: 'games' }])
  })

  test('defaultWebhookTargets covers the fleet once: forge includes and team patterns', () => {
    const config = parseConfig({
      forges: {
        work: { kind: 'gitlab', url: 'https://work.test', create: () => ({}) as GitForge },
        other: { kind: 'gitlab', url: 'https://other.test', create: () => ({}) as GitForge },
      },
      fleet: { work: { include: ['tools/cli'], exclude: [] } },
      teams: {
        shapes: { owns: ['work:shapes/*'] },
        round: { owns: ['work:shapes/circle', 'shapes/oval-*'], consumes: ['work:paints/*'] },
        elsewhere: { owns: ['other:widgets/*'] },
      },
    })
    expect(defaultWebhookTargets(config, 'work')).toEqual([
      { group: 'shapes' },
      { group: 'paints' },
      { project: 'tools/cli' },
    ])
    expect(defaultWebhookTargets(config, 'other')).toEqual([
      { group: 'shapes' },
      { group: 'widgets' },
    ])
  })

  test('team keys: lowercase letters, digits and dashes; teams are not nested', async () => {
    await putForge()
    const shapes = { owns: ['cloud:shapes/*'] }
    expect((await call('PUT', '/config/teams/shapes.round', shapes)).status).toBe(400)
    expect((await call('PUT', '/config/teams/Shapes', shapes)).status).toBe(400)
    expect((await call('PUT', '/config/teams/1shapes', shapes)).status).toBe(400)
    expect((await call('PUT', '/config/teams/shapes', shapes)).status).toBe(200)
    expect(
      (await call('PUT', '/config/teams/round', { owns: ['cloud:shapes/circle'] })).status,
    ).toBe(200)
    expect((await call('PUT', '/config/teams/empty', { owns: [] })).status).toBe(400)
    const teams = (await (await call('GET', '/config/teams')).json()) as ConfigEntryList<'team'>
    expect(teams.entries.map((e) => [e.id, e.data.owns])).toEqual([
      ['round', ['cloud:shapes/circle']],
      ['shapes', ['cloud:shapes/*']],
    ])
    expect((await call('DELETE', '/config/teams/shapes')).status).toBe(204)
    expect(source.current().teams.round).toBeDefined()
  })
})

const as = (user: string, roles = 'none') => ({
  'content-type': 'application/json',
  'x-forwarded-user': user,
  'x-forwarded-groups': roles,
})

describe('team maintainers', () => {
  let teamApp: ReturnType<typeof createApp>
  const teamCall = (
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ) =>
    teamApp.request(`/api${path}`, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
  const games = {
    title: 'Game studio',
    owns: ['cloud:studio/*'],
    exclude: ['cloud:studio/old'],
    consumes: ['cloud:tools/*'],
    members: [
      { id: 'header:mia', role: 'maintainer' },
      { id: 'header:max', role: 'member' },
    ],
  }

  beforeEach(async () => {
    await putForge()
    expect((await call('PUT', '/config/teams/games', games)).status).toBe(200)
    expect(
      (
        await call('PUT', '/config/teams/puzzles', {
          owns: ['cloud:puzzles/*'],
          members: [{ id: 'header:max', role: 'maintainer' }],
        })
      ).status,
    ).toBe(200)
    teamApp = createApp({
      config: liveConfig(source),
      configSource: source,
      auth: headerAuth({
        roles: { admin: [{ scope: { all: true }, actions: ['settings:read', 'settings:write'] }] },
      }),
      store,
      vault,
      credentials: createCredentialService({ credentials: store.credentials, vault }),
      settings: builtinSettings,
      analyses: [],
      now: () => new Date('2026-10-30T12:00:00.000Z'),
    })
  })

  test('a maintainer reads only the teams it maintains and no other config', async () => {
    const list = await teamCall('GET', '/config/teams', as('mia'))
    expect(list.status).toBe(200)
    expect(((await list.json()) as ConfigEntryList<'team'>).entries.map((e) => e.id)).toEqual([
      'games',
    ])
    expect((await teamCall('GET', '/config/teams/games', as('mia'))).status).toBe(200)
    expect((await teamCall('GET', '/config/teams/puzzles', as('mia'))).status).toBe(403)
    expect((await teamCall('GET', '/config/forges', as('mia'))).status).toBe(403)
    expect((await teamCall('GET', '/config/teams', as('nobody'))).status).toBe(403)
  })

  test('a maintainer changes title and members; owns, exclude and consumes stay global', async () => {
    const renamed = await teamCall('PUT', '/config/teams/games', as('mia'), {
      ...games,
      title: 'Arcade',
      members: [...games.members, { id: 'kim@example.test', role: 'member' }],
    })
    expect(renamed.status).toBe(200)
    expect(source.current().teams.games).toMatchObject({
      title: 'Arcade',
      owns: ['cloud:studio/*'],
    })
    expect(source.current().teams.games?.members).toHaveLength(3)

    for (const change of [
      { owns: ['cloud:studio/*', 'cloud:web/*'] },
      { exclude: [] },
      { consumes: ['cloud:**'] },
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one refused change after another
      const refused = await teamCall('PUT', '/config/teams/games', as('mia'), {
        ...games,
        ...change,
      })
      expect(refused.status).toBe(403)
      // oxlint-disable-next-line no-await-in-loop -- reads the response of this iteration
      expect(((await refused.json()) as { error: string }).error).toBe(
        'changing owns, exclude or consumes needs global settings:write; maintainers may change title and members',
      )
    }
    expect(source.current().teams.games?.owns).toEqual(['cloud:studio/*'])

    const created = await teamCall('PUT', '/config/teams/arcade', as('mia'), {
      owns: ['cloud:studio/arcade'],
    })
    expect(created.status).toBe(403)
    expect(((await created.json()) as { error: string }).error).toBe(
      'creating a team or changing one you do not maintain needs global settings:write',
    )
    expect((await teamCall('DELETE', '/config/teams/games', as('mia'))).status).toBe(403)
    expect(source.current().teams.games).toBeDefined()
  })

  test('members, maintainers of other teams and readers may not change a team', async () => {
    expect(
      (await teamCall('PUT', '/config/teams/games', as('max'), { ...games, title: 'Mine' })).status,
    ).toBe(403)
    expect(
      (await teamCall('PUT', '/config/teams/puzzles', as('mia'), { owns: ['cloud:puzzles/*'] }))
        .status,
    ).toBe(403)
    expect(
      (
        await teamCall('PUT', '/config/teams/puzzles', as('max'), {
          title: 'Riddles',
          owns: ['cloud:puzzles/*'],
          members: [{ id: 'header:max', role: 'maintainer' }],
        })
      ).status,
    ).toBe(200)
    expect(source.current().teams.games?.title).toBe('Game studio')
    expect(source.current().teams.puzzles?.title).toBe('Riddles')
  })

  test('global settings:write changes every field and deletes teams', async () => {
    const widened = await teamCall('PUT', '/config/teams/games', as('ada', 'admin'), {
      ...games,
      owns: ['cloud:studio/*', 'cloud:web/*'],
    })
    expect(widened.status).toBe(200)
    expect(source.current().teams.games?.owns).toEqual(['cloud:studio/*', 'cloud:web/*'])
    expect((await teamCall('DELETE', '/config/teams/games', as('ada', 'admin'))).status).toBe(204)
    expect(source.current().teams.games).toBeUndefined()
  })
})
