import { beforeEach, describe, expect, test } from 'bun:test'

import { recordMetrics } from '@holtkeeper/analyzer'
import type {
  CiFleetJobsView,
  CiJobsData,
  CiJobsView,
  CiOverview,
  CiRepoView,
} from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { ciJobsAnalysis } from '@holtkeeper/ci-jobs'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'
import { CI_JOBS_MAX } from '../src/routes/ci.ts'

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
    releases: [{ scope: { groups: ['shapes'] }, actions: ['analyses:read', 'releases:read'] }],
  },
})
const asAdmin = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'admin' }
const asShapes = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'shapes' }
const asReleases = { 'x-forwarded-user': 'ann', 'x-forwarded-groups': 'releases' }

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
      outcomes: { success: 20, failed: 0, canceled: 0 },
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
      outcomes: { success: 15, failed: 4, canceled: 1 },
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

const add = async (path: string, data: unknown, createdAt = '2026-10-30T03:00:00.000Z') => {
  const record = { repo: { forge: 'work', path }, kind: 'ci-jobs', createdAt, data }
  const metrics = await recordMetrics(store.analyses, ciJobsAnalysis, record)
  return store.analyses.add({ ...record, ...(metrics ? { metrics } : {}) })
}

const releases = (value: unknown, scope: { groups: string[] } | { all: true } = { all: true }) =>
  store.settings.put({
    id: `releases-${JSON.stringify(scope)}`,
    key: 'releases',
    scope,
    value,
    secret: false,
    updatedAt: '2026-10-01T00:00:00.000Z',
  })

/** Store calls of the routes, with the limit each asked for. */
const spy = () => {
  const calls: { method: string; limit?: number }[] = []
  const analyses = store.analyses
  store = {
    ...store,
    analyses: {
      ...analyses,
      list: async (query) => (
        calls.push({ method: 'list', limit: query?.limit }),
        analyses.list(query)
      ),
      heads: async (query) => (
        calls.push({ method: 'heads', limit: query?.limit }),
        analyses.heads(query)
      ),
      latest: async (query) => (calls.push({ method: 'latest' }), analyses.latest(query)),
      latestHeads: async (query) => (
        calls.push({ method: 'latestHeads' }),
        analyses.latestHeads(query)
      ),
      get: async (id) => (calls.push({ method: 'get' }), analyses.get(id)),
    },
  }
  return calls
}

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
      groups: ['shapes'],
      status: 'failing',
      flakyJobs: 0,
      queueMedian: 12,
    })
    expect(body.repos[0]?.releaseGate).toBeUndefined()

    const scoped = await overview(asShapes)
    expect(scoped.repos.map((r) => r.repo.path)).toEqual(['shapes/circle'])
  })

  test('the overview reads stored metrics only, never record data', async () => {
    await add('shapes/circle', ciData('2026-10-29T10:00:00.000Z'))
    await add('tools/lint', ciData('2026-10-29T10:00:00.000Z'))
    const calls = spy()
    expect((await overview()).repos).toHaveLength(2)
    expect(calls.map((call) => call.method)).toEqual(['latestHeads'])
  })

  test('a newest record stored with older metrics reads its data once', async () => {
    const created = await add('shapes/circle', ciData('2026-10-29T10:00:00.000Z', 20))
    const {
      weeks: _,
      problems: __,
      outcomes: ___,
      ...older
    } = created.metrics as Record<string, unknown>
    store = memoryStore()
    await store.analyses.add({ ...created, metrics: older })
    const calls = spy()
    expect((await overview()).repos[0]).toMatchObject({ weeks: [280, null], problems: 1 })
    expect(calls.filter((call) => call.method === 'get')).toHaveLength(1)
  })

  test('the release gate shows only with releases:read and releases on', async () => {
    await add('shapes/circle', ciData('2026-10-29T10:00:00.000Z'))
    await add('shapes/square', ciData('2026-10-29T10:00:00.000Z'))
    await add('tools/lint', ciData('2026-10-29T10:00:00.000Z'))
    await releases({ enabled: true, flow: { target: 'stable' } }, { groups: ['shapes'] })
    await releases({ enabled: false })

    const gate = { pipeline: true, branch: 'stable' }
    const admin = await overview()
    expect(admin.repos.map((r) => r.releaseGate)).toEqual([gate, gate, undefined])
    expect((await overview(asShapes)).repos.map((r) => r.releaseGate)).toEqual([
      undefined,
      undefined,
    ])
    expect((await overview(asReleases)).repos.map((r) => r.releaseGate)).toEqual([gate, gate])

    await releases({ enabled: true, gates: { pipeline: false } }, { groups: ['shapes'] })
    expect((await overview(asReleases)).repos.map((r) => r.releaseGate)).toEqual([
      { pipeline: false, branch: 'main' },
      { pipeline: false, branch: 'main' },
    ])
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

  test('the jobs table caps its rows, keeps totals and sums outcomes', async () => {
    await add('shapes/circle', ciData('2026-10-29T10:00:00.000Z', 20))
    const calls = spy()
    const full = (await get('/api/ci/jobs?repo=work:shapes/circle')).body as CiJobsView
    expect(full).toMatchObject({
      repo: { forge: 'work', path: 'shapes/circle' },
      range: { from: '2026-08-01T00:00:00.000Z', to: '2026-10-30T00:00:00.000Z' },
      total: 2,
      outcomes: { success: 35, failed: 4, canceled: 1 },
    })
    expect(full.jobs.map((job) => [job.name, job.problems])).toEqual([
      ['unit', ['failing']],
      ['compile', []],
    ])
    expect(calls.filter((call) => call.method === 'get')).toHaveLength(1)
    expect(calls.some((call) => call.method === 'list' || call.method === 'latest')).toBe(false)

    const capped = (await get('/api/ci/jobs?repo=work:shapes/circle&limit=1')).body as CiJobsView
    expect(capped.jobs).toHaveLength(1)
    expect(capped.total).toBe(2)
    expect(capped.outcomes).toEqual(full.outcomes)
  })

  test('the jobs table never answers more than its hard cap', async () => {
    const data = ciData('2026-10-29T10:00:00.000Z')
    const [job] = data.jobs
    if (!job) throw new Error('no job')
    data.jobs = Array.from({ length: CI_JOBS_MAX + 5 }, (_, index) => ({
      ...job,
      name: `job-${index}`,
    }))
    await add('shapes/circle', data)
    const body = (await get('/api/ci/jobs?repo=work:shapes/circle&limit=100000')).body as CiJobsView
    expect(body.jobs).toHaveLength(CI_JOBS_MAX)
    expect(body.total).toBe(CI_JOBS_MAX + 5)
  })

  test('the jobs table checks the grant, the limit and the record', async () => {
    await add('tools/lint', ciData('2026-10-29T10:00:00.000Z'))
    expect((await get('/api/ci/jobs?repo=work:tools/lint', asShapes)).status).toBe(403)
    expect((await get('/api/ci/jobs?repo=work:tools/lint&limit=0')).status).toBe(400)
    expect((await get('/api/ci/jobs')).status).toBe(400)
    expect((await get('/api/ci/jobs?repo=work:shapes/circle', asShapes)).status).toBe(404)
  })

  test('the fleet jobs table ranks jobs of every readable repository', async () => {
    await add('shapes/circle', ciData('2026-10-29T10:00:00.000Z', 20))
    await add('tools/lint', ciData('2026-10-29T10:00:00.000Z', 20))
    const all = (await get('/api/ci/jobs/fleet')).body as CiFleetJobsView
    expect(all.sort).toBe('slowest')
    expect(all.repos).toBe(2)
    expect(all.total).toBe(4)
    expect(all.jobs.map((job) => job.repo.path)).toContain('tools/lint')
    const medians = all.jobs.map((job) => job.median ?? 0)
    expect(medians).toEqual(medians.toSorted((a, b) => b - a))

    const narrow = (await get('/api/ci/jobs/fleet?sort=unreliable', asShapes))
      .body as CiFleetJobsView
    expect(narrow.repos).toBe(1)
    expect(narrow.jobs.every((job) => job.repo.path === 'shapes/circle')).toBe(true)
    expect(narrow.jobs.every((job) => (job.failureRate ?? 0) > 0 || job.flaky > 0)).toBe(true)
    expect((await get('/api/ci/jobs/fleet?sort=fastest')).status).toBe(400)
  })
})
