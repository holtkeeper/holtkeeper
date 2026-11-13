import { beforeEach, describe, expect, test } from 'bun:test'

import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import type { GitForge, Repository } from '@holtkeeper/forge'
import { createKnowledgeBootstrapAnalyzer } from '@holtkeeper/knowledge-bootstrap'
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

const deps = (config: ServerDeps['config'], list: JobAnalyzerInfo[] = analyzers): ServerDeps => {
  const vault = aesVault('v'.repeat(32))
  return {
    config,
    auth: noAuth(),
    store,
    vault,
    credentials: createCredentialService({
      credentials: store.credentials,
      vault,
    }),
    settings: builtinSettings,
    analyses: [],
    analyzers: list,
    now: () => new Date('2026-11-02T10:00:00.000Z'),
  }
}

const poller = (config: ServerDeps['config'], list?: JobAnalyzerInfo[]) => {
  const d = deps(config, list)
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
    const discovered = (await store.audit.list({ action: 'repo.discover' })).events
    expect(discovered.map((a) => a.target.repo)).toEqual(
      expect.arrayContaining(['work:games/a', 'work:games/b']),
    )
  })

  test('starter knowledge is queued only for new repositories without entries of their own', async () => {
    await store.knowledge.put({
      id: 'k1',
      title: 'Widgets are cached for a minute',
      body: 'The cache lives in the widget client.',
      kind: 'quirk',
      scope: { repos: ['work:games/b'] },
      topics: [],
      appliesTo: ['*'],
      status: 'accepted',
      source: 'human',
      author: 'jane',
      evidence: [],
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    })
    const p = poller(configWith({ onNewRepo: {} }), [
      analyzer('quality'),
      createKnowledgeBootstrapAnalyzer({ store }),
    ])
    listed = ['games/a', 'games/b']
    await p.listGroup('games')
    expect(await queued()).toEqual([
      'games/a knowledge-bootstrap new-repo',
      'games/a quality new-repo',
      'games/b quality new-repo',
    ])
  })

  test('kinds with a daily limit spread their jobs over the next days', async () => {
    const p = poller(configWith({ onNewRepo: {} }), [
      analyzer('quality'),
      analyzer('starter', { dailyLimit: 2 }),
    ])
    listed = ['games/a', 'games/b', 'games/c']
    await p.listGroup('games')
    const jobs = await store.jobs.list({})
    const runAfter = (kind: string) =>
      jobs
        .filter((job) => job.analyzer === kind)
        .map((job) => job.runAfter)
        .toSorted()
    expect(runAfter('quality')).toEqual(Array(3).fill('2026-11-02T10:00:00.000Z'))
    expect(runAfter('starter')).toEqual([
      '2026-11-02T10:00:00.000Z',
      '2026-11-02T10:00:00.000Z',
      '2026-11-03T00:00:00.000Z',
    ])
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

  test('coverage is never queued for a repository with no tests by design', async () => {
    await store.settings.put({
      id: 's1',
      key: 'repo.tests',
      value: { expected: false },
      secret: false,
      scope: { repos: ['work:games/b'] },
      updatedAt: '2026-10-30T00:00:00.000Z',
    })
    const withCoverage = [...analyzers, analyzer('coverage')]
    const p = poller(
      configWith({ onNewRepo: { analyzers: ['quality', 'coverage'] } }),
      withCoverage,
    )
    listed = ['games/a', 'games/b']
    await p.listGroup('games')
    const dispatch = createEventDispatcher(
      deps(configWith({ onPush: { analyzers: ['coverage'] } }), withCoverage),
    )
    await dispatch(
      {
        kind: 'push',
        repo: { forge: 'work', path: 'games/b' },
        branch: 'x',
        sha: 'abc',
        actor: '',
      },
      { actor: 'poll', via: 'poll' },
    )
    expect(await queued()).toEqual([
      'games/a coverage new-repo',
      'games/a quality new-repo',
      'games/b quality new-repo',
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
    const runs = (await store.audit.list({ action: 'trigger.run_result' })).events
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
