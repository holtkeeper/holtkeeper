import { beforeEach, describe, expect, test } from 'bun:test'

import type { CiJobsData, CiOverview, CiRepoView } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { ciJobsAnalysis } from '@holtkeeper/ci-jobs'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'

const config = parseConfig({
  forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => ({}) as never } },
  groups: {
    shapes: { forge: 'work', include: ['shapes/circle', 'shapes/square'] },
    tools: { forge: 'work', include: ['tools/lint'] },
  },
})

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['*'] }],
    shapes: [{ scope: { groups: ['shapes'] }, actions: ['analyses:read'] }],
  },
})
const asAdmin = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'admin' }
const asShapes = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'shapes' }

const ciData = (lastRunAt: string, failureRate = 0): CiJobsData => ({
  window: { from: '2026-08-01T00:00:00.000Z', to: '2026-10-30T00:00:00.000Z', days: 90 },
  options: { days: 90, recentDays: 14, changePercent: 20, minChangeSeconds: 15 },
  defaultBranch: 'main',
  history: { jobs: 40 },
  lastRunAt,
  pipelines: {
    ref: 'main',
    count: 20,
    successRate: 95,
    duration: { samples: 19, median: 300, p90: 420 },
    queue: { samples: 40, median: 12, p90: 30 },
    change: 12,
  },
  weeks: [
    { week: '2026-10-19', pipelines: 10, median: 280 },
    { week: '2026-10-26', pipelines: 10 },
  ],
  stages: ['build', 'check'],
  jobs: [
    {
      name: 'compile',
      stage: 'build',
      runs: 20,
      pipelines: 20,
      failures: 0,
      failureRate: 0,
      retryRate: 0,
      flaky: 0,
      allowFailure: false,
      duration: { samples: 20, median: 200 },
      trend: 'stable',
      weeks: [190, null],
      last: { at: lastRunAt, status: 'success', href: 'https://gitlab.test/jobs/1' },
    },
    {
      name: 'unit',
      stage: 'check',
      runs: 20,
      pipelines: 20,
      failures: 4,
      failureRate,
      retryRate: 0,
      flaky: 0,
      allowFailure: false,
      duration: { samples: 16, median: 100 },
      trend: 'stable',
      weeks: [100, null],
      last: { at: lastRunAt, status: 'failed', href: 'https://gitlab.test/jobs/2' },
    },
  ],
})

let store: Store

const setup = () => {
  const vault = aesVault('v'.repeat(32))
  return createApp({
    config,
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [ciJobsAnalysis],
    now: () => new Date('2026-10-30T12:00:00.000Z'),
  })
}

const add = (path: string, data: unknown, createdAt = '2026-10-30T03:00:00.000Z') =>
  store.analyses.add({ repo: { forge: 'work', path }, kind: 'ci-jobs', createdAt, data })

const get = async (path: string, headers = asAdmin) => {
  const response = await setup().request(path, { headers })
  return { status: response.status, body: await response.json() }
}
const overview = async (headers = asAdmin) => (await get('/api/ci', headers)).body as CiOverview
const repoView = async (path: string) =>
  (await get(`/api/ci/repo?repo=work:${path}`)).body as CiRepoView

beforeEach(() => {
  store = memoryStore()
})

describe('CI routes', () => {
  test('the overview lists active repositories the caller may read, from their newest record', async () => {
    await add('shapes/circle', ciData('2026-10-01T00:00:00.000Z'), '2026-10-01T03:00:00.000Z')
    await add('shapes/circle', ciData('2026-10-29T10:00:00.000Z', 20))
    await add('shapes/square', ciData('2026-09-01T00:00:00.000Z'))
    await add('tools/lint', ciData('2026-10-29T10:00:00.000Z'))
    await add('shapes/triangle', { totals: { runs: 1 }, notes: [] })

    const body = await overview()
    expect(body.repos.map((r) => r.repo.path)).toEqual(['shapes/circle', 'tools/lint'])
    expect(body.repos[0]).toMatchObject({
      ref: 'main',
      pipelines: 20,
      median: 300,
      p90: 420,
      successRate: 95,
      change: 12,
      weeks: [280, null],
      problems: 1,
    })

    const scoped = await overview(asShapes)
    expect(scoped.repos.map((r) => r.repo.path)).toEqual(['shapes/circle'])
  })

  test('the repository view carries the data, problem jobs and per-job flags', async () => {
    await add('shapes/circle', ciData('2026-10-29T10:00:00.000Z', 20))
    const body = await repoView('shapes/circle')
    expect(body.data?.stages).toEqual(['build', 'check'])
    expect(body.problems).toEqual([
      {
        job: 'unit',
        stage: 'check',
        kind: 'failing',
        reason: 'fails in 20% of runs',
        href: 'https://gitlab.test/jobs/2',
      },
    ])
    expect(body.flags).toEqual({ unit: ['failing'] })
  })

  test('a repository without a current record answers without data; others are forbidden', async () => {
    await add('shapes/square', { totals: { runs: 1 }, refGroups: [] })
    const body = await repoView('shapes/square')
    expect(body).toMatchObject({ repo: { path: 'shapes/square' }, problems: [], flags: {} })
    expect(body.data).toBeUndefined()
    expect(body.analysisId).toBeDefined()
    const forbidden = await get('/api/ci/repo?repo=work:tools/lint', asShapes)
    expect(forbidden.status).toBe(403)
  })
})
