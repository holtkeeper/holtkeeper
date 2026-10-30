import { describe, expect, test } from 'bun:test'

import { memoryArtifactStore } from '@holtkeeper/artifacts'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import type { AnyAnalyzer } from '@holtkeeper/jobs'
import { createLimiter } from '@holtkeeper/limits'
import type { Job } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { z } from 'zod'

import { createProbes, opsFetch } from '../src/health.ts'
import { limiterOptionsFor } from '../src/limiter-state.ts'
import { createMetrics, renderMetrics } from '../src/metrics.ts'
import { parseRoles, roleDuties } from '../src/roles.ts'
import { startServer } from '../src/server.ts'

describe('roles', () => {
  test('parses single and combined roles and rejects unknown ones', () => {
    expect(parseRoles(undefined)).toEqual(['all'])
    expect(parseRoles('')).toEqual(['all'])
    expect(parseRoles('worker')).toEqual(['worker'])
    expect(parseRoles('web, scheduler,web')).toEqual(['web', 'scheduler'])
    expect(() => parseRoles('janitor')).toThrow(/unknown role "janitor"/)
  })

  test('maps roles to duties', () => {
    expect(roleDuties(['web'])).toEqual({ http: 'api', worker: false, scheduler: false })
    expect(roleDuties(['worker'])).toEqual({ http: 'probes', worker: true, scheduler: false })
    expect(roleDuties(['scheduler'])).toEqual({ http: 'probes', worker: false, scheduler: true })
    expect(roleDuties(['all'])).toEqual({ http: 'api', worker: true, scheduler: true })
    expect(roleDuties(['web', 'scheduler'])).toEqual({
      http: 'api',
      worker: false,
      scheduler: true,
    })
  })
})

describe('probes', () => {
  test('readiness fails while draining or when a dependency is down', async () => {
    const store = memoryStore()
    let draining = false
    let artifactsDown = false
    const artifacts = memoryArtifactStore()
    const probes = createProbes({
      store,
      artifacts: {
        ...artifacts,
        list: async (options) => {
          if (artifactsDown) throw new Error('bucket unreachable')
          return artifacts.list(options)
        },
      },
      draining: () => draining,
    })
    expect(probes.live().status).toBe(200)
    let response = await probes.ready()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'ok',
      checks: { store: 'ok', artifacts: 'ok' },
    })

    artifactsDown = true
    response = await probes.ready()
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      status: 'unavailable',
      checks: { artifacts: 'bucket unreachable' },
    })

    artifactsDown = false
    draining = true
    response = await probes.ready()
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ status: 'draining' })
  })

  test('opsFetch answers probes itself, passes the rest on and counts webhooks', async () => {
    const store = memoryStore()
    const metrics = createMetrics({ store, cluster: false })
    const probes = createProbes({ store, draining: () => false })
    const fetch = opsFetch({ probes, metrics }, (request) =>
      new URL(request.url).pathname === '/api/webhooks/work'
        ? new Response('no', { status: 401 })
        : new Response('app'),
    )
    expect((await fetch(new Request('http://x/healthz'))).status).toBe(200)
    expect(await (await fetch(new Request('http://x/other'))).text()).toBe('app')
    await fetch(new Request('http://x/api/webhooks/work', { method: 'POST' }))
    const page = await (await fetch(new Request('http://x/metrics'))).text()
    expect(page).toContain('holtkeeper_webhook_events_total{forge="work",status="401"} 1')
    const probesOnly = opsFetch({ probes, metrics })
    expect((await probesOnly(new Request('http://x/api/me'))).status).toBe(404)
  })
})

describe('metrics', () => {
  test('renders families in the Prometheus text format with escaped labels', () => {
    const text = renderMetrics([
      {
        name: 'x_total',
        help: 'Things.',
        type: 'counter',
        samples: [{ labels: { key: 'a"b\\c\nd' }, value: 2 }],
      },
    ])
    expect(text).toBe(
      '# HELP x_total Things.\n# TYPE x_total counter\nx_total{key="a\\"b\\\\c\\nd"} 2\n',
    )
  })

  test('reports the queue, durations, AI usage, limiter keys and artifact bytes', async () => {
    const store = memoryStore()
    const at = Date.parse('2026-10-30T10:00:00.000Z')
    const repo = { forge: 'work', path: 'games/a' }
    await store.jobs.enqueue({
      analyzer: 'size',
      repo,
      trigger: 'manual',
      createdAt: new Date(at - 1000).toISOString(),
    })
    await store.jobs.enqueue({
      analyzer: 'size',
      repo: { forge: 'work', path: 'games/b' },
      trigger: 'manual',
      createdAt: new Date(at - 1000).toISOString(),
      runAfter: new Date(at + 60_000).toISOString(),
    })
    await store.aiUsage.append({
      at: new Date(at).toISOString(),
      repo,
      groups: [],
      taskKind: 'review',
      actor: 'system',
      provider: 'anthropic',
      model: 'claude-x',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.5,
      costSource: 'reported',
      durationMs: 1000,
      turns: 1,
      outcome: 'ok',
    })
    const artifacts = memoryArtifactStore()
    await artifacts.put(new Uint8Array(10))
    const limiter = createLimiter()
    limiter.configure('cred-1', { maxConcurrent: 1 })
    const lease = await limiter.acquire('cred-1')
    const metrics = createMetrics({ store, limiter, artifacts, now: () => at })
    metrics.observeJob({
      analyzer: 'size',
      status: 'succeeded',
      startedAt: new Date(at).toISOString(),
      finishedAt: new Date(at + 42_000).toISOString(),
    } as Job)

    const text = await metrics.render()
    expect(text).toContain('holtkeeper_jobs_queued 1\n')
    expect(text).toContain('holtkeeper_jobs{status="queued"} 2\n')
    expect(text).toContain('holtkeeper_jobs{status="running"} 0\n')
    expect(text).toContain('holtkeeper_jobs_finished_total{analyzer="size",status="succeeded"} 1\n')
    expect(text).toContain('holtkeeper_job_duration_seconds_bucket{analyzer="size",le="30"} 0\n')
    expect(text).toContain('holtkeeper_job_duration_seconds_bucket{analyzer="size",le="60"} 1\n')
    expect(text).toContain('holtkeeper_job_duration_seconds_bucket{analyzer="size",le="+Inf"} 1\n')
    expect(text).toContain('holtkeeper_job_duration_seconds_sum{analyzer="size"} 42\n')
    expect(text).toContain('holtkeeper_ai_runs_total{provider="anthropic",model="claude-x"} 1\n')
    expect(text).toContain(
      'holtkeeper_ai_tokens_total{provider="anthropic",model="claude-x",kind="output"} 20\n',
    )
    expect(text).toContain(
      'holtkeeper_ai_cost_usd_total{provider="anthropic",model="claude-x"} 0.5\n',
    )
    expect(text).toContain('holtkeeper_limiter_saturated{key="cred-1"} 1\n')
    expect(text).toContain('holtkeeper_limiter_in_flight{key="cred-1"} 1\n')
    expect(text).toContain('holtkeeper_artifact_store_bytes 10\n')
    expect(text).toContain('holtkeeper_draining 0\n')
    await lease.release()
  })

  test('without cluster metrics only process-local series are reported', async () => {
    const text = await createMetrics({ store: memoryStore(), cluster: false }).render()
    expect(text).not.toContain('holtkeeper_jobs_queued')
    expect(text).toContain('holtkeeper_jobs_finished_total')
  })
})

describe('limiterOptionsFor', () => {
  test('uses the store kv only when limits are distributed', () => {
    const store = memoryStore()
    expect(limiterOptionsFor({}, store)).toEqual({})
    expect(limiterOptionsFor({ limits: { distributed: false } }, store)).toEqual({})
    expect(limiterOptionsFor({ limits: { distributed: true } }, store).state).toBeDefined()
    expect(() => limiterOptionsFor({ limits: { distributed: true } }, {})).toThrow(/compareAndSet/)
  })
})

const configFor = (store: ReturnType<typeof memoryStore>, port: number) =>
  parseConfig({
    forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => ({}) as never } },
    server: { auth: noAuth(), store, vaultKey: 'test-vault-key-0123456789-0123456789', port },
    jobs: { schedules: [] },
  })

describe('startServer roles', () => {
  const echo: AnyAnalyzer = {
    kind: 'echo',
    analysis: { kind: 'echo', label: 'Echo' } as AnyAnalyzer['analysis'],
    scope: 'repo',
    needs: {},
    options: z.object({}),
    run: async () => ({ data: {} }),
  }

  test('a worker serves only probes and resolves exhausted after --max-jobs', async () => {
    const store = memoryStore()
    const port = 20_000 + Math.floor(Math.random() * 20_000)
    await store.jobs.enqueue({
      analyzer: 'echo',
      repo: { forge: 'work', path: 'games/a' },
      trigger: 'manual',
      createdAt: new Date(Date.now() - 1000).toISOString(),
    })
    const running = await startServer(configFor(store, port), {
      roles: ['worker'],
      worker: { maxJobs: 1 },
      analyzers: [echo],
      artifacts: memoryArtifactStore(),
      log: () => {},
    })
    try {
      await running.exhausted
      expect((await fetch(`${running.url}/healthz`)).status).toBe(200)
      expect((await fetch(`${running.url}/readyz`)).status).toBe(200)
      expect((await fetch(`${running.url}/api/me`)).status).toBe(404)
      const [job] = await store.jobs.list()
      expect(job?.attempts).toBe(1)
      expect(job?.status).not.toBe('running')
    } finally {
      await running.stop()
    }
  })

  test('a web process serves the API next to the probes', async () => {
    const store = memoryStore()
    const port = 20_000 + Math.floor(Math.random() * 20_000)
    const running = await startServer(configFor(store, port), {
      roles: ['web'],
      analyzers: [echo],
      artifacts: memoryArtifactStore(),
      log: () => {},
    })
    try {
      expect((await fetch(`${running.url}/api/me`)).status).toBe(200)
      expect((await fetch(`${running.url}/readyz`)).status).toBe(200)
      expect((await store.settings.get('default:llm.model'))?.value).toBe('claude-opus@latest')
      expect(await (await fetch(`${running.url}/metrics`)).text()).toContain(
        'holtkeeper_jobs_queued',
      )
    } finally {
      await running.stop()
    }
  })
})
