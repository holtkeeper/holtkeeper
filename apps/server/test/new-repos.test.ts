import { beforeEach, describe, expect, test } from 'bun:test'

import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import type { GitForge, Repository } from '@holtkeeper/forge'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { z } from 'zod'

import { createApp } from '../src/app.ts'
import type { JobAnalyzerInfo, ServerDeps } from '../src/context.ts'
import { createEventDispatcher } from '../src/events.ts'
import { newRepoAnalyzers } from '../src/new-repos.ts'
import { serverPoller } from '../src/updates.ts'

let store: Store
let listed: string[]

const repository = (path: string): Repository => ({
  path,
  name: path,
  defaultBranch: 'main',
  webUrl: '',
  cloneUrl: '',
  archived: false,
})

const fakeForge = {
  kind: 'gitlab',
  async *listRepositories() {
    for (const path of listed) yield repository(path)
  },
  getRepository: async (path: string) => repository(path),
  readFile: async (repo: string, file: string) =>
    repo.startsWith('shop/') && file === 'go.mod' ? 'module x' : undefined,
} as unknown as GitForge

const analyzer = (kind: string, extra: Partial<JobAnalyzerInfo> = {}): JobAnalyzerInfo => ({
  kind,
  scope: 'repo',
  options: z.object({}),
  ...extra,
})

const analyzers = [
  analyzer('quality'),
  analyzer('licenses'),
  analyzer('go-only', {
    appliesTo: async ({ repo, forge }) => !!(await forge.readFile(repo.path, 'go.mod')),
  }),
  analyzer('renovate', { exclusive: true }),
  analyzer('fleet', { scope: 'group' }),
  analyzer('build', { options: z.object({ command: z.string(), branch: z.string().optional() }) }),
]

const configWith = (jobs: Record<string, unknown>) =>
  parseConfig({
    forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => fakeForge } },
    groups: {
      games: { forge: 'work', include: ['games/*'] },
      shop: { forge: 'work', include: ['shop/*'] },
    },
    jobs,
  })

const deps = (config: ServerDeps['config']): ServerDeps => {
  const vault = aesVault('v'.repeat(32))
  return {
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
    now: () => new Date('2026-11-02T10:00:00.000Z'),
  }
}

const poller = (config: ServerDeps['config']) => {
  const d = deps(config)
  const result = serverPoller(d, createEventDispatcher(d))
  if (!result) throw new Error('no poller')
  return result
}

const queued = async () =>
  (await store.jobs.list({}))
    .map((job) => `${job.repo.path} ${job.analyzer} ${job.trigger}`)
    .toSorted()

beforeEach(() => {
  store = memoryStore()
  listed = []
})

describe('jobs.onNewRepo', () => {
  test('queues read-only analyzers once for repositories a listing finds first', async () => {
    const p = poller(configWith({ onNewRepo: {} }))
    listed = ['games/a']
    await p.listGroup('games')
    expect(await queued()).toEqual(['games/a licenses new-repo', 'games/a quality new-repo'])

    listed = ['games/a', 'games/b']
    await p.listGroup('games')
    expect(await queued()).toEqual([
      'games/a licenses new-repo',
      'games/a quality new-repo',
      'games/b licenses new-repo',
      'games/b quality new-repo',
    ])
    const activity = await store.activity.list()
    expect(activity.filter((a) => a.action === 'job.new_repo').map((a) => a.subject)).toEqual(
      expect.arrayContaining(['work:games/a', 'work:games/b']),
    )
  })

  test('honors analyzers, exclude and groups', async () => {
    const p = poller(
      configWith({
        onNewRepo: { analyzers: ['quality', 'go-only', 'renovate'], groups: ['shop'] },
      }),
    )
    listed = ['games/a', 'shop/b']
    await p.listGroup('games')
    await p.listGroup('shop')
    expect(await queued()).toEqual(['shop/b go-only new-repo', 'shop/b quality new-repo'])
  })

  test('a repository another group already listed is not new', async () => {
    const config = parseConfig({
      forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => fakeForge } },
      groups: {
        games: { forge: 'work', include: ['games/*'] },
        everything: { forge: 'work', include: ['**'] },
      },
      jobs: { onNewRepo: { exclude: ['licenses'] } },
    })
    const p = poller(config)
    listed = ['games/a']
    await p.listGroup('games')
    await p.listGroup('everything')
    expect(await queued()).toEqual(['games/a quality new-repo'])
  })

  test('skips analyzers whose required options are not set up for the repository', async () => {
    await store.settings.put({
      id: 's1',
      key: 'analyzers.build',
      value: { command: 'make' },
      secret: false,
      scope: { repos: ['work:games/b'] },
      updatedBy: 'u1',
      updatedAt: '2026-10-30T00:00:00.000Z',
    })
    const p = poller(configWith({ onNewRepo: { analyzers: ['quality', 'build'] } }))
    listed = ['games/a', 'games/b']
    await p.listGroup('games')
    expect(await queued()).toEqual([
      'games/a quality new-repo',
      'games/b build new-repo',
      'games/b quality new-repo',
    ])
  })

  test('push jobs skip analyzers not set up for the repository', async () => {
    await store.settings.put({
      id: 's1',
      key: 'analyzers.build',
      value: { command: 'make' },
      secret: false,
      scope: { repos: ['work:games/b'] },
      updatedBy: 'u1',
      updatedAt: '2026-10-30T00:00:00.000Z',
    })
    const dispatch = createEventDispatcher(
      deps(configWith({ onPush: { analyzers: ['quality', 'build'] } })),
    )
    for (const path of ['games/a', 'games/b'])
      await dispatch(
        {
          kind: 'push',
          repo: { forge: 'work', path },
          branch: 'feature/x',
          sha: 'abc123',
          actor: '',
        },
        { actor: 'poll', via: 'poll' },
      )
    expect(await queued()).toEqual([
      'games/a quality poll',
      'games/b build poll',
      'games/b quality poll',
    ])
  })

  test('queues nothing without the trigger', async () => {
    const p = poller(configWith({}))
    listed = ['games/a']
    await p.listGroup('games')
    expect(await queued()).toEqual([])
  })
})

describe('running the trigger on known repositories', () => {
  test('queues for every repository of every group, once, and logs the run', async () => {
    const background: Promise<unknown>[] = []
    const app = createApp({
      ...deps(configWith({ onNewRepo: { analyzers: ['quality'] } })),
      onBackground: (work) => background.push(work),
    })
    listed = ['games/a', 'shop/b']
    const response = await app.request('/api/triggers/new-repo/run', { method: 'POST' })
    expect(response.status).toBe(202)
    await Promise.all(background)
    expect(await queued()).toEqual(['games/a quality new-repo', 'shop/b quality new-repo'])

    await app.request('/api/triggers/new-repo/run', { method: 'POST' })
    await Promise.all(background)
    expect(await queued()).toHaveLength(2)
    const runs = (await store.activity.list()).filter((a) => a.action === 'trigger.new_repo.run')
    expect(runs.map((a) => a.details)).toEqual(
      expect.arrayContaining([
        { queued: 2, skipped: 0 },
        { queued: 0, skipped: 2 },
      ]),
    )
  })

  test('answers 409 without the trigger', async () => {
    const app = createApp(deps(configWith({})))
    expect((await app.request('/api/triggers/new-repo/run', { method: 'POST' })).status).toBe(409)
  })
})

test('newRepoAnalyzers: never group-scope or exclusive ones', () => {
  expect(newRepoAnalyzers({}, analyzers)).toEqual(['quality', 'licenses', 'go-only', 'build'])
  expect(newRepoAnalyzers({ exclude: ['quality'] }, analyzers)).toEqual([
    'licenses',
    'go-only',
    'build',
  ])
  expect(newRepoAnalyzers({ analyzers: ['renovate', 'fleet', 'licenses'] }, analyzers)).toEqual([
    'licenses',
  ])
})
