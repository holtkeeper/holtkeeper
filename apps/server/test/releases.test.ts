import { beforeEach, describe, expect, test } from 'bun:test'

import type { ReleaseBackfillResult } from '@holtkeeper/api'
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

beforeEach(() => {
  listed.length = 0
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
    ],
    now: () => new Date('2026-10-30T12:00:00.000Z'),
  })
})

const backfill = (body: unknown, headers = asAdmin) =>
  app.request('/api/releases/backfill', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('release backfill', () => {
  test('queues a changelog per tag, oldest first, and skips analyzed tags', async () => {
    await store.analyses.add({
      repo: { forge: 'work', path: 'games/a' },
      kind: 'changelog',
      ref: 'v1.0.0',
      createdAt: '2026-10-01T00:00:00.000Z',
      data: {},
    })
    const response = await backfill({ repo: 'work:games/a', limit: 3 })
    expect(response.status).toBe(201)
    expect((await response.json()) as ReleaseBackfillResult).toEqual({
      repos: 1,
      tags: 3,
      queued: 2,
      skipped: 1,
      errors: [],
    })
    const jobs = await store.jobs.list({ repo: { forge: 'work', path: 'games/a' } })
    expect(jobs.map((job) => [job.analyzer, job.ref, job.actor]).toReversed()).toEqual([
      ['changelog', 'v1.1.0', 'header:jane'],
      ['changelog', 'v1.2.0', 'header:jane'],
    ])
    const again = (await (await backfill({ repo: 'work:games/a' })).json()) as ReleaseBackfillResult
    expect(again).toMatchObject({ queued: 0, skipped: 3 })
  })

  test('every repository of every group, with risk assessments when asked', async () => {
    const result = (await (
      await backfill({ limit: 2, risk: true })
    ).json()) as ReleaseBackfillResult
    expect(result).toMatchObject({ repos: 3, tags: 6, queued: 12 })
    const jobs = await store.jobs.list({ repo: { forge: 'work', path: 'games/b' } })
    expect(jobs.map((job) => `${job.analyzer} ${job.ref}`).toReversed()).toEqual([
      'changelog v1.1.0',
      'release-risk v1.1.0',
      'changelog v1.2.0',
      'release-risk v1.2.0',
    ])
  })

  test('a monorepo commit carrying package tags is one release', async () => {
    const result = (await (
      await backfill({ repo: 'work:libs/ui', limit: 2 })
    ).json()) as ReleaseBackfillResult
    expect(result).toMatchObject({ tags: 2, queued: 2, skipped: 0 })
    const jobs = await store.jobs.list({ repo: { forge: 'work', path: 'libs/ui' } })
    expect(jobs.map((job) => job.ref).toReversed()).toEqual(['e', 'f'])
    expect(listed).toEqual([
      { repo: 'libs/ui', limit: 2 },
      { repo: 'libs/ui', limit: 20 },
    ])
  })

  test('plain repositories list their tags once', async () => {
    await backfill({ repo: 'work:games/a', limit: 2 })
    expect(listed).toEqual([{ repo: 'games/a', limit: 2 }])
  })

  test('the whole fleet needs analyses:run everywhere', async () => {
    expect((await backfill({}, asGames)).status).toBe(403)
    expect((await backfill({ repo: 'work:games/a' }, asGames)).status).toBe(201)
  })
})
