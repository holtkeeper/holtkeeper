import { beforeEach, expect, test } from 'bun:test'

import type { AnalysisDetail } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { type BranchesData, branchesMetrics } from '@holtkeeper/branches'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { JobQuery, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { builtinAnalyses } from '../src/analyses.ts'
import { createApp } from '../src/app.ts'

const config = parseConfig({
  forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => ({}) as never } },
  groups: {
    shapes: { forge: 'work', include: ['shapes/*'] },
    colors: { forge: 'work', include: ['colors/*'] },
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

const at = '2026-11-10T12:00:00.000Z'
const value: BranchesData = {
  defaultBranch: 'main',
  staleDays: 90,
  checkedAt: at,
  total: 3,
  open: 0,
  candidates: [],
}

let store: Store
let app: ReturnType<typeof createApp>
let jobReads: JobQuery[]

beforeEach(() => {
  store = memoryStore()
  jobReads = []
  const vault = aesVault('v'.repeat(32))
  const jobs = store.jobs
  app = createApp({
    config,
    auth,
    store: {
      ...store,
      jobs: {
        ...jobs,
        list: async (query) => {
          jobReads.push(query ?? {})
          return jobs.list(query)
        },
      },
    },
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: builtinAnalyses,
    now: () => new Date(at),
  })
})

const record = (path = 'shapes/circle') =>
  store.analyses.add({
    repo: { forge: 'work', path },
    kind: 'branches',
    createdAt: at,
    data: value,
    metrics: branchesMetrics(value),
  })

const finishedJob = async (analysisId: string, extra: { repo?: string; group?: string } = {}) => {
  const job = await store.jobs.enqueue({
    analyzer: 'branches',
    repo: { forge: 'work', path: extra.repo ?? 'shapes/circle' },
    ...(extra.group ? { group: extra.group } : {}),
    options: { staleDays: 90 },
    trigger: 'manual',
    actor: 'user:jane',
    reason: 'asked from the panel',
    createdAt: '2026-11-10T11:00:00.000Z',
  })
  await store.jobs.claim('worker-1', '2026-11-10T11:00:01.000Z')
  await store.jobs.complete(job.id, { at: '2026-11-10T11:01:00.000Z', analysisId })
  return job
}

const detail = async (id: string, headers = asAdmin) => {
  const response = await app.request(`/api/analyses/${id}`, { headers })
  expect(response.status).toBe(200)
  return (await response.json()) as AnalysisDetail
}

test('the record names the job that produced it, with only its summary fields', async () => {
  const stored = await record()
  const job = await finishedJob(stored.id)
  const result = await detail(stored.id, asShapes)
  expect(result.job).toEqual({
    id: job.id,
    status: 'succeeded',
    trigger: 'manual',
    analyzer: 'branches',
    createdAt: '2026-11-10T11:00:00.000Z',
    finishedAt: '2026-11-10T11:01:00.000Z',
  })
  expect(jobReads).toEqual([{ analysisId: stored.id, limit: 1 }])
})

test('uploads and records whose job is gone have no job', async () => {
  const stored = await record()
  expect((await detail(stored.id)).job).toBeUndefined()
})

test('a job the caller may not read is left out', async () => {
  const stored = await record()
  await finishedJob(stored.id, { repo: 'colors', group: 'colors' })
  expect((await detail(stored.id, asShapes)).job).toBeUndefined()
  expect((await detail(stored.id, asAdmin)).job?.analyzer).toBe('branches')
})
