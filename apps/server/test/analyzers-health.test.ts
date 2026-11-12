import { beforeEach, expect, test } from 'bun:test'

import type { AnalyzerHealthList } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { z } from 'zod'

import { createApp } from '../src/app.ts'
import type { JobAnalyzerInfo } from '../src/context.ts'

const config = parseConfig({
  forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => ({}) as never } },
  groups: {
    web: { forge: 'work', include: ['acme/web-*'] },
    pay: { forge: 'work', include: ['acme/pay-*'] },
  },
})

const analyzers: JobAnalyzerInfo[] = [
  { kind: 'widgets', scope: 'repo', options: z.object({}) },
  { kind: 'gadgets', scope: 'repo', options: z.object({}) },
]

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['analyses:read'] }],
    web: [{ scope: { groups: ['web'] }, actions: ['analyses:read'] }],
  },
})
const as = (role: string) => ({ 'x-forwarded-user': role, 'x-forwarded-groups': role })

const now = new Date('2026-11-12T12:00:00.000Z')
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString()

let store: Store
let app: ReturnType<typeof createApp>

/** Queues a job, runs it for `minutes` and finishes it as `outcome`. */
async function run(
  analyzer: string,
  path: string,
  at: string,
  outcome: 'succeeded' | 'failed' | 'queued',
  minutes = 2,
) {
  const job = await store.jobs.enqueue({
    analyzer,
    repo: { forge: 'work', path },
    trigger: 'manual',
    createdAt: at,
    runAfter: at,
    maxAttempts: 1,
  })
  if (outcome === 'queued') return job
  const claimed = await store.jobs.claim('w1', at)
  expect(claimed?.id).toBe(job.id)
  const end = new Date(Date.parse(at) + minutes * 60_000).toISOString()
  if (outcome === 'succeeded') await store.jobs.complete(job.id, { at: end })
  else await store.jobs.fail(job.id, { at: end, error: 'boom' })
  return job
}

const health = async (role: string) => {
  const response = await app.request('/api/jobs/analyzers/health', { headers: as(role) })
  expect(response.status).toBe(200)
  return (await response.json()) as AnalyzerHealthList
}

beforeEach(async () => {
  store = memoryStore()
  const vault = aesVault('v'.repeat(32))
  app = createApp({
    config,
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [],
    analyzers,
    now: () => now,
  })
  await run('widgets', 'acme/web-shop', hoursAgo(24 * 9), 'failed')
  await run('widgets', 'acme/web-shop', hoursAgo(30), 'succeeded', 2)
  await run('widgets', 'acme/web-admin', hoursAgo(20), 'failed', 4)
  await run('widgets', 'acme/pay-ledger', hoursAgo(10), 'succeeded', 6)
  await run('widgets', 'acme/pay-ledger', hoursAgo(1), 'queued')
})

test('counts runs, failures, targets and durations per analyzer over seven days', async () => {
  const list = await health('admin')
  expect(list.days).toBe(7)
  expect(list.analyzers).toEqual([
    {
      analyzer: 'widgets',
      runs: 3,
      failed: 1,
      blocked: 0,
      targets: 3,
      lastRunAt: new Date(Date.parse(hoursAgo(10)) + 6 * 60_000).toISOString(),
      lastFailureAt: new Date(Date.parse(hoursAgo(20)) + 4 * 60_000).toISOString(),
      medianDurationMs: 4 * 60_000,
    },
    { analyzer: 'gadgets', runs: 0, failed: 0, blocked: 0, targets: 0 },
  ])
})

test('a narrow grant only counts jobs of repositories it may read', async () => {
  const [widgets] = (await health('web')).analyzers
  expect(widgets).toMatchObject({ analyzer: 'widgets', runs: 2, failed: 1, targets: 2 })
  expect(widgets?.medianDurationMs).toBe(2 * 60_000)
})

test('needs a principal', async () => {
  expect((await app.request('/api/jobs/analyzers/health')).status).toBe(401)
})
