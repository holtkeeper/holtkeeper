import { beforeEach, describe, expect, test } from 'bun:test'

import type { ReleaseBackfillStarted } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { z } from 'zod'

import { createApp } from '../src/app.ts'

const tags = [
  { name: 'v1.2.0', sha: 'c', committedAt: '2026-10-03T00:00:00Z' },
  { name: 'v1.1.0', sha: 'b', committedAt: '2026-10-02T00:00:00Z' },
  { name: 'v1.0.0', sha: 'a', committedAt: '2026-10-01T00:00:00Z' },
]

const packageTags = [
  { name: '@games/card@0.7.0', sha: 'f', committedAt: '2026-10-03T00:00:00Z' },
  { name: '@games/common@1.4.0', sha: 'f', committedAt: '2026-10-03T00:00:00Z' },
  { name: '@games/common@1.3.1', sha: 'e', committedAt: '2026-10-02T00:00:00Z' },
  { name: '@games/card@0.6.0', sha: 'd', committedAt: '2026-10-01T00:00:00Z' },
  { name: '@games/chip@1.5.0', sha: 'd', committedAt: '2026-10-01T00:00:00Z' },
]

const listed: { repo: string; limit?: number }[] = []

const config = parseConfig({
  forges: {
    work: {
      kind: 'gitlab',
      url: 'https://gitlab.test',
      create: () =>
        ({
          getRepository: async () => ({ archived: false }),
          listTags: async (repo: string, query: { limit?: number } = {}) => {
            listed.push({ repo, ...query })
            return (repo === 'libs/ui' ? packageTags : tags).slice(0, query.limit)
          },
        }) as never,
    },
  },
  groups: {
    games: { forge: 'work', include: ['games/a', 'games/b'] },
    libs: { forge: 'work', include: ['libs/ui'] },
  },
  jobs: {},
})

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['analyses:read', 'analyses:run'] }],
    games: [{ scope: { groups: ['games'] }, actions: ['analyses:run'] }],
  },
})
const asAdmin = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'admin' }
const asGames = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'games' }

let store: Store
let app: ReturnType<typeof createApp>
let background: Promise<unknown>[]

beforeEach(() => {
  listed.length = 0
  background = []
  store = memoryStore()
  const vault = aesVault('v'.repeat(32))
  app = createApp({
    config,
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
    analyzers: [
      { kind: 'changelog', scope: 'repo', options: z.object({}) },
      { kind: 'release-risk', scope: 'repo', options: z.object({}) },
      { kind: 'api-surface', scope: 'repo', options: z.object({}) },
    ],
    now: () => new Date('2026-10-30T12:00:00.000Z'),
    onBackground: (work) => {
      background.push(work)
    },
  })
})

const backfill = (body: unknown, headers = asAdmin) =>
  app.request('/api/releases/backfill', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** Runs a backfill to the end and returns what its activity entry recorded. */
async function backfilled(body: unknown) {
  const seen = new Set((await store.activity.list()).map((entry) => entry.id))
  const response = await backfill(body)
  expect(response.status).toBe(202)
  await Promise.all(background)
  background = []
  const entry = (await store.activity.list()).find((event) => !seen.has(event.id))
  expect(entry?.action).toBe('releases.backfill')
  return entry?.details
}

describe('release backfill', () => {
  test('answers at once and queues a changelog per tag in the background, oldest first', async () => {
    await store.analyses.add({
      repo: { forge: 'work', path: 'games/a' },
      kind: 'changelog',
      ref: 'v1.0.0',
      createdAt: '2026-10-01T00:00:00.000Z',
      data: {},
    })
    const response = await backfill({ repo: 'work:games/a', limit: 3 })
    expect(response.status).toBe(202)
    expect((await response.json()) as ReleaseBackfillStarted).toEqual({
      startedAt: '2026-10-30T12:00:00.000Z',
    })
    await Promise.all(background)
    background = []
    const [entry] = await store.activity.list()
    expect(entry).toMatchObject({
      action: 'releases.backfill',
      actor: 'header:jane',
      subject: 'work:games/a',
      details: { limit: 3, risk: false, repos: 1, releases: 3, queued: 2, skipped: 1 },
    })
    const jobs = await store.jobs.list({ repo: { forge: 'work', path: 'games/a' } })
    expect(jobs.map((job) => [job.analyzer, job.ref, job.actor]).toReversed()).toEqual([
      ['changelog', 'v1.1.0', 'header:jane'],
      ['changelog', 'v1.2.0', 'header:jane'],
    ])
    expect(await backfilled({ repo: 'work:games/a' })).toMatchObject({ queued: 0, skipped: 3 })
  })

  test('every repository of every group, with risk assessments when asked', async () => {
    expect(await backfilled({ limit: 2, risk: true })).toMatchObject({
      repos: 3,
      releases: 6,
      queued: 12,
    })
    const jobs = await store.jobs.list({ repo: { forge: 'work', path: 'games/b' } })
    expect(jobs.map((job) => `${job.analyzer} ${job.ref}`).toReversed()).toEqual([
      'changelog v1.1.0',
      'release-risk v1.1.0',
      'changelog v1.2.0',
      'release-risk v1.2.0',
    ])
  })

  test('snapshots the public API of each release when asked', async () => {
    expect(await backfilled({ repo: 'work:games/a', limit: 1, api: true })).toMatchObject({
      queued: 2,
    })
    const jobs = await store.jobs.list({ repo: { forge: 'work', path: 'games/a' } })
    expect(jobs.map((job) => `${job.analyzer} ${job.ref}`).toReversed()).toEqual([
      'changelog v1.2.0',
      'api-surface v1.2.0',
    ])
    expect((await store.activity.list())[0]?.details).toMatchObject({ api: true, risk: false })
  })

  test('each analyzer skips only the releases it has analyzed', async () => {
    const repo = { forge: 'work', path: 'games/a' }
    for (const ref of ['v1.1.0', 'v1.2.0'])
      // oxlint-disable-next-line no-await-in-loop -- two records in order
      await store.analyses.add({
        repo,
        kind: 'changelog',
        ref,
        createdAt: '2026-10-01T00:00:00.000Z',
        data: {},
      })
    expect(await backfilled({ repo: 'work:games/a', limit: 2, risk: true })).toMatchObject({
      queued: 2,
      skipped: 2,
    })
    const jobs = await store.jobs.list({ repo })
    expect(jobs.map((job) => `${job.analyzer} ${job.ref}`).toReversed()).toEqual([
      'release-risk v1.1.0',
      'release-risk v1.2.0',
    ])
  })

  test('retakes public API snapshots that found no packages', async () => {
    const repo = { forge: 'work', path: 'games/a' }
    for (const [ref, packages] of [
      ['v1.1.0', []],
      ['v1.2.0', [{ name: '@games/a' }]],
    ] as const)
      // oxlint-disable-next-line no-await-in-loop -- two records in order
      await store.analyses.add({
        repo,
        kind: 'api-surface',
        ref,
        createdAt: '2026-10-01T00:00:00.000Z',
        data: { packages },
      })
    await backfilled({ repo: 'work:games/a', limit: 2, api: true })
    const jobs = await store.jobs.list({ repo })
    expect(jobs.filter((job) => job.analyzer === 'api-surface').map((job) => job.ref)).toEqual([
      'v1.1.0',
    ])
  })

  test('a monorepo commit carrying package tags is one release', async () => {
    expect(await backfilled({ repo: 'work:libs/ui', limit: 2 })).toMatchObject({
      releases: 2,
      queued: 2,
      skipped: 0,
    })
    const jobs = await store.jobs.list({ repo: { forge: 'work', path: 'libs/ui' } })
    expect(jobs.map((job) => job.ref).toReversed()).toEqual(['e', 'f'])
    expect(listed).toEqual([
      { repo: 'libs/ui', limit: 2 },
      { repo: 'libs/ui', limit: 20 },
    ])
  })

  test('plain repositories list their tags once', async () => {
    await backfilled({ repo: 'work:games/a', limit: 2 })
    expect(listed).toEqual([{ repo: 'games/a', limit: 2 }])
  })

  test('validates before answering', async () => {
    expect((await backfill({}, asGames)).status).toBe(403)
    expect((await backfill({ group: 'nope' })).status).toBe(400)
    expect((await backfill({ repo: 'work:games/a' }, asGames)).status).toBe(202)
  })
})
