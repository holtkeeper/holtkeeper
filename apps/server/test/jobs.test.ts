import { beforeEach, describe, expect, test } from 'bun:test'

import type { Job, JobAnalyzerList, JobList, RepoExplain, RuntimeConfigView } from '@holtkeeper/api'
import type { AuthProvider } from '@holtkeeper/auth'
import { headerAuth } from '@holtkeeper/auth-header'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { z } from 'zod'

import { createApp } from '../src/app.ts'
import type { JobAnalyzerInfo } from '../src/context.ts'

const forge = { kind: 'gitlab', url: 'https://gitlab.test', create: () => ({}) as never }

const baseConfig = {
  forges: { work: forge },
  groups: {
    games: { forge: 'work', include: ['games/*'] },
    tools: { forge: 'work', include: ['tools/*'] },
  },
}
const config = parseConfig({
  ...baseConfig,
  jobs: {
    onTag: { analyzers: ['changelog', 'fleet', 'unknown'], groups: ['games'] },
    webhookSecret: 'hook-secret',
  },
})

const analyzers: JobAnalyzerInfo[] = [
  { kind: 'changelog', scope: 'repo', options: z.object({ from: z.string().optional() }) },
  { kind: 'fleet', scope: 'group', options: z.object({}) },
]

const games = headerAuth({
  roles: {
    games: [{ scope: { groups: ['games'] }, actions: ['analyses:read', 'analyses:run'] }],
    reader: [{ scope: { groups: ['games'] }, actions: ['analyses:read'] }],
  },
})
const asGames = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'games' }
const asReader = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'reader' }

let store: Store
const setup = (auth: AuthProvider = noAuth(), cfg = config, list = analyzers) => {
  const vault = aesVault('v'.repeat(32))
  return createApp({
    config: cfg,
    auth,
    store,
    vault,
    credentials: createCredentialService({
      credentials: store.credentials,
      activity: store.activity,
      vault,
    }),
    settings: builtinSettings,
    analyses: [],
    analyzers: list,
    now: () => new Date('2026-10-30T12:00:00.000Z'),
  })
}

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

beforeEach(() => {
  store = memoryStore()
})

describe('job routes', () => {
  test('queues, lists, shows and cancels jobs', async () => {
    const app = setup()
    const created = await send(app, 'POST', '/api/jobs', {
      analyzer: 'changelog',
      repo: 'work:games/a',
      ref: 'v1.2.0',
      options: { from: 'v1.1.0' },
    })
    expect(created.status).toBe(201)
    const job = (await created.json()) as Job
    expect(job).toMatchObject({
      analyzer: 'changelog',
      repo: { forge: 'work', path: 'games/a' },
      ref: 'v1.2.0',
      trigger: 'manual',
      status: 'queued',
      actor: 'root',
    })

    const group = (await (
      await send(app, 'POST', '/api/jobs', { analyzer: 'fleet', group: 'games' })
    ).json()) as Job
    expect(group).toMatchObject({ repo: { forge: 'work', path: 'games' }, group: 'games' })

    const list = (await (await app.request('/api/jobs?status=queued&limit=10')).json()) as JobList
    expect(list.jobs.map((j) => j.analyzer)).toEqual(['fleet', 'changelog'])
    expect('log' in (list.jobs[0] ?? {})).toBeFalse()
    const byRepo = (await (await app.request('/api/jobs?repo=work:games/a')).json()) as JobList
    expect(byRepo.jobs.map((j) => j.id)).toEqual([job.id])
    const byAnalyzer = (await (await app.request('/api/jobs?analyzer=fleet')).json()) as JobList
    expect(byAnalyzer.jobs.map((j) => j.id)).toEqual([group.id])
    expect((await app.request('/api/jobs?status=bogus')).status).toBe(400)

    await store.jobs.appendLog(job.id, ['hello'])
    const detail = (await (await app.request(`/api/jobs/${job.id}`)).json()) as Job
    expect(detail.log).toEqual(['hello'])
    expect((await app.request('/api/jobs/missing')).status).toBe(404)

    const canceled = await send(app, 'POST', `/api/jobs/${job.id}/cancel`)
    expect(((await canceled.json()) as Job).status).toBe('canceled')
    expect((await send(app, 'POST', `/api/jobs/${job.id}/cancel`)).status).toBe(409)
    expect((await store.activity.list()).map((e) => e.action).toSorted()).toEqual([
      'job.canceled',
      'job.created',
      'job.created',
    ])
  })

  test('validates analyzer, target and options', async () => {
    const app = setup()
    const error = async (body: unknown) => {
      const response = await send(app, 'POST', '/api/jobs', body)
      expect(response.status).toBe(400)
      return ((await response.json()) as { error: string }).error
    }
    expect(await error({ analyzer: 'nope', repo: 'work:games/a' })).toContain('unknown analyzer')
    expect(await error({ analyzer: 'changelog', group: 'games' })).toContain('pass repo')
    expect(await error({ analyzer: 'fleet', repo: 'work:games/a' })).toContain('pass group')
    expect(await error({ analyzer: 'fleet', group: 'nope' })).toContain('unknown group')
    expect(await error({ analyzer: 'changelog', repo: 'other:games/a' })).toContain(
      'not configured',
    )
    expect(
      await error({ analyzer: 'changelog', repo: 'work:games/a', options: { from: 1 } }),
    ).toContain('from')
  })

  test('refuses to queue when jobs are not configured', async () => {
    const app = setup(noAuth(), parseConfig(baseConfig))
    const response = await send(app, 'POST', '/api/jobs', {
      analyzer: 'changelog',
      repo: 'work:games/a',
    })
    expect(response.status).toBe(409)
  })

  test('checks analyses permissions on the repository', async () => {
    const tools = await store.jobs.enqueue({
      analyzer: 'changelog',
      repo: { forge: 'work', path: 'tools/x' },
      trigger: 'schedule',
      createdAt: '2026-10-30T10:00:00.000Z',
    })
    await store.jobs.enqueue({
      analyzer: 'changelog',
      repo: { forge: 'work', path: 'games/a' },
      trigger: 'schedule',
      createdAt: '2026-10-30T11:00:00.000Z',
    })
    const app = setup(games)

    const list = (await (await app.request('/api/jobs', { headers: asGames })).json()) as JobList
    expect(list.jobs.map((j) => j.repo.path)).toEqual(['games/a'])
    expect((await app.request(`/api/jobs/${tools.id}`, { headers: asGames })).status).toBe(403)
    expect((await app.request('/api/jobs')).status).toBe(401)
    expect(
      (
        await send(
          app,
          'POST',
          '/api/jobs',
          { analyzer: 'changelog', repo: 'work:tools/x' },
          asGames,
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await send(
          app,
          'POST',
          '/api/jobs',
          { analyzer: 'changelog', repo: 'work:games/a' },
          asReader,
        )
      ).status,
    ).toBe(403)
    expect(
      (await send(app, 'POST', '/api/jobs', { analyzer: 'fleet', group: 'games' }, asGames)).status,
    ).toBe(201)
  })
})

describe('analyzers, explain and runtime', () => {
  test('lists analyzers with JSON Schema options', async () => {
    const list = (await (await setup().request('/api/jobs/analyzers')).json()) as JobAnalyzerList
    expect(list.enabled).toBeTrue()
    expect(list.analyzers.map(({ kind, label, scope }) => ({ kind, label, scope }))).toEqual([
      { kind: 'changelog', label: 'changelog', scope: 'repo' },
      { kind: 'fleet', label: 'fleet', scope: 'group' },
    ])
    expect(list.analyzers[0]?.schema).toMatchObject({ properties: { from: { type: 'string' } } })
    const off = (await (
      await setup(noAuth(), parseConfig(baseConfig)).request('/api/jobs/analyzers')
    ).json()) as JobAnalyzerList
    expect(off.enabled).toBeFalse()
  })

  test('explains a repository and hides plugin options without settings:read', async () => {
    const explained = (await (
      await setup().request('/api/repos/explain?repo=work:games/a')
    ).json()) as RepoExplain
    expect(explained).toEqual({
      repo: { forge: 'work', path: 'games/a' },
      groups: ['games'],
      traits: {},
      plugins: [],
      schedules: [],
      triggers: [{ id: 'tag', analyzers: ['changelog', 'fleet', 'unknown'] }],
    })
    const tools = (await (
      await setup().request('/api/repos/explain?repo=work:tools/x')
    ).json()) as RepoExplain
    expect(tools.triggers).toEqual([])
    expect((await setup().request('/api/repos/explain')).status).toBe(400)
    const reader = setup(
      headerAuth({ roles: { r: [{ scope: { all: true }, actions: ['repos:read'] }] } }),
    )
    expect(
      (
        await reader.request('/api/repos/explain?repo=work:games/a', {
          headers: { 'x-forwarded-user': 'r', 'x-forwarded-groups': 'r' },
        })
      ).status,
    ).toBe(200)
  })

  test('shows the file-only config without secrets', async () => {
    const view = (await (await setup().request('/api/config/runtime')).json()) as RuntimeConfigView
    expect(view).toMatchObject({
      dryRun: false,
      jobs: { concurrency: 2, timeoutMinutes: 30, schedules: 0 },
      limits: { distributed: false },
      aiProviders: [],
      plugins: [],
    })
    expect(JSON.stringify(view)).not.toContain('hook-secret')
    expect((await setup(games).request('/api/config/runtime', { headers: asGames })).status).toBe(
      403,
    )
  })
})

const tagPush = (path: string, tag: string, after = 'a'.repeat(40)) => ({
  object_kind: 'tag_push',
  ref: `refs/tags/${tag}`,
  after,
  project: { path_with_namespace: path, web_url: `https://gitlab.test/${path}` },
})
const branchPush = (path: string, branch: string, after = 'c'.repeat(40)) => ({
  object_kind: 'push',
  ref: `refs/heads/${branch}`,
  after,
  user_username: 'jane',
  project: { path_with_namespace: path, web_url: `https://gitlab.test/${path}` },
})
const hook = (
  app: ReturnType<typeof setup>,
  body: unknown,
  token = 'hook-secret',
  event = 'Tag Push Hook',
) =>
  send(app, 'POST', '/api/webhooks/gitlab', body, {
    'x-gitlab-token': token,
    'x-gitlab-event': event,
  })

const ignored = async (response: Response) => {
  expect(response.status).toBe(200)
  return ((await response.json()) as { ignored: string }).ignored
}

describe('gitlab webhook', () => {
  test('queues onTag analyzers for the tagged repository', async () => {
    const app = setup(games)
    const response = await hook(app, tagPush('games/a', 'v2.0.0'))
    expect(response.status).toBe(202)
    const jobs = await store.jobs.list()
    expect(
      jobs.map((j) => `${j.analyzer} ${j.repo.path} ${j.ref ?? '-'} ${j.trigger}`).toSorted(),
    ).toEqual(['changelog games/a v2.0.0 tag', 'fleet games - tag', 'unknown games/a v2.0.0 tag'])

    await hook(app, tagPush('games/a', 'v2.0.0'))
    expect(await store.jobs.list()).toHaveLength(3)
    expect((await store.activity.list())[0]?.action).toBe('job.tag_pushed')
  })

  test('queues one job per commit for monorepo package tags', async () => {
    const app = setup(games)
    const sha = 'b'.repeat(40)
    await hook(app, tagPush('games/a', '@games/card@0.7.0', sha))
    await hook(app, tagPush('games/a', '@games/common@1.4.0', sha))
    const jobs = await store.jobs.list({ analyzer: 'changelog' })
    expect(jobs.map((job) => job.ref)).toEqual([sha])
  })

  test('verifies the token', async () => {
    const app = setup()
    expect((await hook(app, tagPush('games/a', 'v1'), 'wrong')).status).toBe(401)
    expect((await send(app, 'POST', '/api/webhooks/gitlab', tagPush('games/a', 'v1'))).status).toBe(
      401,
    )
    expect(await store.jobs.list()).toEqual([])
    const disabled = setup(noAuth(), parseConfig(baseConfig))
    expect((await hook(disabled, tagPush('games/a', 'v1'))).status).toBe(404)
  })

  test('ignores unconfigured pushes, deleted tags and repositories outside onTag groups', async () => {
    const app = setup()
    expect(
      await ignored(await hook(app, branchPush('games/a', 'main'), 'hook-secret', 'Push Hook')),
    ).toContain('onPush')
    expect(await ignored(await hook(app, tagPush('games/a', 'v1', '0'.repeat(40))))).toContain(
      'deleted',
    )
    expect(await ignored(await hook(app, tagPush('tools/x', 'v1')))).toContain('onTag.groups')
    expect((await hook(app, { object_kind: 'tag_push' })).status).toBe(400)
    expect(await store.jobs.list()).toEqual([])
  })
})

const push = (app: ReturnType<typeof setup>, branch: string, after?: string) =>
  hook(app, branchPush('games/a', branch, after), 'hook-secret', 'Push Hook')

describe('branch push webhook', () => {
  const withPush = parseConfig({
    ...baseConfig,
    jobs: {
      onPush: { analyzers: ['changelog', 'fleet'], branches: ['main', 'release/*'] },
      webhookSecret: 'hook-secret',
    },
  })

  test('queues repo analyzers for matching branches with the commit and branch', async () => {
    const app = setup(noAuth(), withPush)
    expect((await push(app, 'release/1.2')).status).toBe(202)
    const jobs = await store.jobs.list()
    expect(jobs.map((j) => [j.analyzer, j.ref, j.options, j.trigger])).toEqual([
      ['changelog', 'c'.repeat(40), { branch: 'release/1.2' }, 'push'],
    ])
    expect((await store.activity.list())[0]?.action).toBe('job.branch_pushed')
  })

  test('a newer push cancels the queued job of the same branch', async () => {
    const app = setup(noAuth(), withPush)
    await push(app, 'main', 'd'.repeat(40))
    await push(app, 'main', 'e'.repeat(40))
    const jobs = await store.jobs.list()
    expect(jobs.map((j) => `${j.ref?.[0]} ${j.status}`).toSorted()).toEqual([
      'd canceled',
      'e queued',
    ])
  })

  test('ignores other branches, deleted branches and tags', async () => {
    const app = setup(noAuth(), withPush)
    expect(await ignored(await push(app, 'feature/x'))).toContain('onPush.branches')
    expect(await ignored(await push(app, 'main', '0'.repeat(40)))).toContain('deleted')
    expect(
      await ignored(
        await hook(
          app,
          { ...branchPush('games/a', 'x'), ref: 'refs/tags/v1' },
          'hook-secret',
          'Push Hook',
        ),
      ),
    ).toContain('not to a branch')
    expect(await store.jobs.list()).toEqual([])
  })
})

const dependencyPush = (
  branch: string,
  commits: { added?: string[]; modified?: string[]; removed?: string[] }[],
  extra: Record<string, unknown> = {},
) => ({
  ...branchPush('games/a', branch),
  before: 'b'.repeat(40),
  project: {
    path_with_namespace: 'games/a',
    web_url: 'https://gitlab.test/games/a',
    default_branch: 'main',
  },
  commits,
  total_commits_count: commits.length,
  ...extra,
})
const pushHook = (app: ReturnType<typeof setup>, body: unknown) =>
  hook(app, body, 'hook-secret', 'Push Hook')

describe('dependency refresh on push', () => {
  const withUsages: JobAnalyzerInfo[] = [
    ...analyzers,
    { kind: 'usages', scope: 'repo', options: z.object({}) },
  ]
  test('a lockfile change on the default branch queues usages and the group fleet', async () => {
    const app = setup(noAuth(), config, withUsages)
    const response = await pushHook(
      app,
      dependencyPush('main', [{ modified: ['src/a.ts'] }, { modified: ['apps/web/bun.lock'] }]),
    )
    expect(response.status).toBe(202)
    const jobs = await store.jobs.list()
    expect(
      jobs
        .toSorted((a, b) => a.analyzer.localeCompare(b.analyzer))
        .map((j) => [j.analyzer, j.repo.path, j.ref, j.options]),
    ).toEqual([
      ['fleet', 'games', undefined, {}],
      ['usages', 'games/a', 'c'.repeat(40), { branch: 'main' }],
    ])
    expect((await store.activity.list())[0]?.action).toBe('job.dependencies_changed')
  })

  test('other files, other branches and a turned off refresh queue nothing', async () => {
    const app = setup(noAuth(), config, withUsages)
    expect(
      await ignored(await pushHook(app, dependencyPush('main', [{ added: ['README.md'] }]))),
    ).toBe('jobs.onPush is not configured')
    await pushHook(app, dependencyPush('feature/x', [{ modified: ['package.json'] }]))
    await store.settings.put({
      id: 'libraries-global',
      key: 'libraries',
      scope: { all: true },
      value: { refreshOnPush: false },
      secret: false,
      updatedAt: '2026-10-30T12:00:00.000Z',
    })
    await pushHook(app, dependencyPush('main', [{ modified: ['go.mod'] }]))
    expect(await store.jobs.list()).toEqual([])
  })

  test('a push whose commits the hook does not all list refreshes to be safe', async () => {
    const app = setup(noAuth(), config, withUsages)
    await pushHook(
      app,
      dependencyPush('main', [{ modified: ['src/a.ts'] }], { total_commits_count: 40 }),
    )
    expect(
      (await store.jobs.list()).map((j) => j.analyzer).toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(['fleet', 'usages'])
  })
})
