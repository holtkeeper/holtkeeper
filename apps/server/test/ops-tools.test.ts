import { beforeEach, describe, expect, test } from 'bun:test'

import type { Principal } from '@holtkeeper/access'
import type { RegistryToolset } from '@holtkeeper/agent-tools'
import { type ArtifactStore, memoryArtifactStore } from '@holtkeeper/artifacts'
import { parseConfig } from '@holtkeeper/core'
import { createJobLog, touchWorker } from '@holtkeeper/jobs'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { z } from 'zod'

import { agentOpsAccess, principalOpsAccess } from '../src/ops-tools.ts'
import { opsToolset } from '../src/tools/ops.ts'
import { mcpToolsets } from '../src/tools/registry.ts'

const config = parseConfig({
  forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => ({}) as never } },
  groups: {
    shapes: { forge: 'work', include: ['shapes/*'] },
    colors: { forge: 'work', include: ['colors/*'] },
  },
})

const now = () => new Date('2026-05-06T12:00:00.000Z')
const analyzers = [
  { kind: 'widgets', scope: 'repo' as const, options: z.object({}), after: ['graph'] },
  { kind: 'graph', scope: 'repo' as const, options: z.object({}) },
]

let store: Store
let artifacts: ArtifactStore
const deps = () => ({ store, config, artifacts, analyzers, now })

const enqueue = (path: string, minute: number, analyzer = 'widgets') =>
  store.jobs.enqueue({
    analyzer,
    repo: { forge: 'work', path },
    trigger: 'schedule',
    schedule: 'nightly',
    createdAt: `2026-05-06T10:${String(minute).padStart(2, '0')}:00.000Z`,
    actor: 'header:pat',
  })

const call = async (toolset: RegistryToolset, name: string, args: Record<string, unknown>) => {
  const tool = toolset.tools.find((entry) => entry.name === name)
  if (!tool) throw new Error(`no tool ${name}`)
  return tool.run(tool.input.parse(args), { dir: '.', signal: new AbortController().signal })
}

const addMetrics = (kind: string, metrics: object) =>
  store.analyses.add({
    repo: { forge: 'work', path: 'shapes/circle' },
    kind,
    createdAt: '2026-05-06T09:00:00.000Z',
    data: {},
    metrics,
  })

const spend = (path: string, group: string, costUsd: number, extra: object = {}) =>
  store.aiUsage.append({
    at: '2026-05-05T12:00:00.000Z',
    repo: { forge: 'work', path },
    groups: [group],
    taskKind: 'review',
    actor: 'system',
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd,
    costSource: 'reported',
    durationMs: 10,
    turns: 1,
    outcome: 'ok',
    ...extra,
  })

beforeEach(() => {
  store = memoryStore()
  artifacts = memoryArtifactStore()
})

describe('ops toolset', () => {
  test('an agent reads jobs of its repository and teammates only, without who asked', async () => {
    const mine = await enqueue('shapes/circle', 1)
    await enqueue('colors/red', 2)
    const ops = opsToolset(
      agentOpsAccess(deps(), { forge: 'work', path: 'shapes/square', groups: ['shapes'] }),
      now,
    )
    expect(ops.tools.map((tool) => [tool.name, tool.readOnly ?? true])).toEqual([
      ['jobs', true],
      ['job_log', true],
      ['queue_stats', true],
      ['why_job', true],
      ['analysis_status', true],
      ['budget_status', true],
      ['fleet_health', true],
    ])
    const listed = await call(ops, 'jobs', {})
    expect(listed).toContain(mine.id)
    expect(listed).toContain('work:shapes/circle · schedule (nightly)')
    expect(listed).not.toContain('colors/red')
    expect(listed).not.toContain('pat')
    expect(
      await call(ops, 'jobs', { repo: 'work:colors/red' }).catch((e: Error) => e.message),
    ).toContain('No readable repository')
  })

  test('a chat agent reads only what the asking person may read too', async () => {
    const circle = await enqueue('shapes/circle', 1)
    const square = await enqueue('shapes/square', 2)
    const target = { forge: 'work', path: 'shapes/circle', groups: ['shapes'] }
    const asker: Principal = {
      id: 'header:kim',
      name: 'Kim',
      provider: 'header',
      grants: [
        { scope: { groups: ['shapes'] }, actions: ['repos:read'] },
        { scope: { repos: ['work:shapes/circle'] }, actions: ['analyses:read'] },
      ],
    }
    const ops = opsToolset(agentOpsAccess(deps(), target, asker), now)
    expect(ops.tools.map((tool) => tool.name)).toEqual([
      'jobs',
      'job_log',
      'queue_stats',
      'why_job',
      'analysis_status',
      'fleet_health',
    ])
    const listed = await call(ops, 'jobs', {})
    expect(listed).toContain(circle.id)
    expect(listed).not.toContain(square.id)

    const reader: Principal = {
      ...asker,
      grants: [...asker.grants, { scope: { groups: ['shapes'] }, actions: ['ai:read'] }],
    }
    const budgets = await call(
      opsToolset(agentOpsAccess(deps(), target, reader), now),
      'budget_status',
      {},
    )
    expect(budgets).not.toContain('default')
  })

  test('queue_stats returns the stats of GET /api/jobs/stats, narrowed by grants', async () => {
    await enqueue('shapes/circle', 1)
    await enqueue('shapes/square', 2)
    await enqueue('colors/red', 3)
    await touchWorker(store.kv!, 'worker-a', now())
    const narrowPrincipal: Principal = {
      id: 'header:kim',
      name: 'Kim',
      provider: 'header',
      grants: [{ scope: { groups: ['shapes'] }, actions: ['analyses:read'] }],
    }
    const narrow = principalOpsAccess(deps(), narrowPrincipal)
    const stats = await narrow.stats()
    expect(stats.queue).toEqual({ queued: 2, running: 0, failed: 0, blocked: 0 })
    expect(stats.workers).toBeUndefined()
    const text = await call(opsToolset(narrow, now), 'queue_stats', {})
    expect(text).toContain('Queued 2, running 0')
    expect(text).toContain('a free worker slot (2)')
    expect(text).not.toContain('worker-a')

    const admin: Principal = {
      ...narrowPrincipal,
      grants: [{ scope: { all: true }, actions: ['analyses:read'] }],
    }
    const all = await call(opsToolset(principalOpsAccess(deps(), admin), now), 'queue_stats', {})
    expect(all).toContain('Queued 3, running 0')
    expect(all).toContain('worker-a (0 running')

    const agent = agentOpsAccess(deps(), { forge: 'work', path: 'colors/red', groups: ['colors'] })
    expect((await agent.stats()).queue.queued).toBe(1)
    expect((await agent.stats()).workers).toBeUndefined()
  })

  test('job_log shows the steps and the tail, why_job explains a waiting job', async () => {
    const graph = await enqueue('shapes/circle', 1, 'graph')
    await store.jobs.claim('w1', '2026-05-06T10:05:00.000Z')
    const log = createJobLog(artifacts, { jobId: graph.id, attempt: 1, now })
    await log.step('checkout', async () => log.write('cloned widget repo'))
    await log
      .step('analyze', async () => {
        throw new Error('graph exploded')
      })
      .catch(() => {})
    await log.close()
    const waiting = await enqueue('shapes/circle', 6)

    const ops = opsToolset(
      agentOpsAccess(deps(), { forge: 'work', path: 'shapes/circle', groups: ['shapes'] }),
      now,
    )
    const text = await call(ops, 'job_log', { job: graph.id })
    expect(text).toContain('✓ checkout')
    expect(text).toContain('✗ analyze')
    expect(text).toContain('[checkout] cloned widget repo')
    expect(await call(ops, 'job_log', { job: graph.id, grep: 'exploded' })).not.toContain('cloned')
    expect(await call(ops, 'job_log', { job: waiting.id })).toContain('has not started yet')

    const why = await call(ops, 'why_job', { job: waiting.id })
    expect(why).toContain('Origin: Schedule nightly queued it.')
    expect(why).toContain('waits for graph on this repository (running)')
    expect(await call(ops, 'why_job', { job: 'missing' }).catch((e: Error) => e.message)).toContain(
      'No readable job missing',
    )
  })

  test('budget_status lists budgets covering the repository; MCP callers need ai:read', async () => {
    await store.settings.put({
      id: 'colors-budget',
      key: 'llm.budget',
      scope: { groups: ['colors'] },
      value: { weeklyUsd: 40 },
      secret: false,
      updatedAt: '2026-05-01T00:00:00.000Z',
    })
    const agent = opsToolset(
      agentOpsAccess(deps(), { forge: 'work', path: 'shapes/circle', groups: ['shapes'] }),
      now,
    )
    const budgets = await call(agent, 'budget_status', {})
    expect(budgets).toContain('default (everything): $0.00 of $150.00')
    expect(budgets).not.toContain('colors')

    const reader: Principal = {
      id: 'header:sam',
      name: 'Sam',
      provider: 'header',
      grants: [{ scope: { groups: ['shapes'] }, actions: ['analyses:read'] }],
    }
    const toolsets = mcpToolsets({ ops: principalOpsAccess(deps(), reader) } as never)
    expect(toolsets.find((toolset) => toolset.name === 'ops')?.tools.map((t) => t.name)).toEqual([
      'jobs',
      'job_log',
      'queue_stats',
      'why_job',
      'analysis_status',
      'fleet_health',
    ])
  })

  test('budget_status adds the forecast and the week split by task kind, analyzer and provider', async () => {
    await spend('shapes/circle', 'shapes', 2, { analyzer: 'widgets' })
    await spend('shapes/square', 'shapes', 1, { taskKind: 'chat', interactive: true })
    await spend('colors/red', 'colors', 50, { taskKind: 'triage', provider: 'gateway' })

    const agent = opsToolset(
      agentOpsAccess(deps(), { forge: 'work', path: 'shapes/circle', groups: ['shapes'] }),
      now,
    )
    const text = await call(agent, 'budget_status', {})
    expect(text).toContain('$53.00 of $150.00')
    expect(text).toContain('forecast $')
    expect(text).toContain('$3.00 over 2 runs')
    expect(text).toContain('By task kind: review $2.00 (1 runs), chat $1.00 (1 runs)')
    expect(text).toContain('By analyzer: widgets $2.00 (1 runs), none (people) $1.00 (1 runs)')
    expect(text).toContain('By provider: anthropic $3.00 (2 runs)')
    expect(text).not.toContain('triage')

    const reader: Principal = {
      id: 'header:sam',
      name: 'Sam',
      provider: 'header',
      grants: [{ scope: { groups: ['colors'] }, actions: ['analyses:read', 'ai:read'] }],
    }
    const mcp = await call(opsToolset(principalOpsAccess(deps(), reader), now), 'budget_status', {})
    expect(mcp).toContain('No AI budget you may read applies.')
    expect(mcp).toContain('By task kind: triage $50.00 (1 runs)')
    expect(mcp).not.toContain('widgets')
  })

  test('analysis_status shows the health cells the caller may read', async () => {
    await addMetrics('coverage', { percent: 42, target: 60, files: 2, untested: 1 })
    await addMetrics('ci-jobs', {
      status: 'healthy',
      pipelines: 12,
      median: 250,
      queue: 46,
      failing: 0,
      flaky: 0,
      slower: 0,
      weeks: [250],
      problems: 0,
    })
    await addMetrics('audit', {
      findings: 1,
      severities: { critical: 1, high: 0, medium: 0, low: 0, unknown: 0 },
      ignored: 0,
      expired: 0,
      resolved: 0,
    })
    const known = [
      ...analyzers,
      { kind: 'coverage', scope: 'repo' as const, options: z.object({}) },
      { kind: 'audit', scope: 'repo' as const, options: z.object({}) },
      { kind: 'ci-jobs', scope: 'repo' as const, options: z.object({}) },
    ]
    const reader: Principal = {
      id: 'header:sam',
      name: 'Sam',
      provider: 'header',
      grants: [{ scope: { groups: ['shapes'] }, actions: ['analyses:read'] }],
    }
    const mcp = opsToolset(principalOpsAccess({ ...deps(), analyzers: known }, reader), now)
    const text = await call(mcp, 'analysis_status', { repo: 'work:shapes/circle' })
    expect(text).toContain('# Health of work:shapes/circle: failing')
    expect(text).toContain('- coverage: 42% (below 60%) · bad')
    expect(text).toContain('- ci: Passing (4m 10s · queue 46s) · ok')
    expect(text).not.toContain('security')
    expect(text).not.toContain('release')

    const agent = opsToolset(
      agentOpsAccess(
        { ...deps(), analyzers: known },
        { forge: 'work', path: 'shapes/circle', groups: ['shapes'] },
      ),
      now,
    )
    expect(await call(agent, 'analysis_status', { repo: 'work:shapes/circle' })).toContain(
      '- security: 1 critical · bad',
    )
    expect(await call(agent, 'analysis_status', { repo: 'work:shapes' })).not.toContain('Health')
  })
  test('fleet_health lists every readable member with the cells the caller may read', async () => {
    await store.kv?.set('poll-group:shapes', {
      repos: [
        { forge: 'work', path: 'shapes/circle' },
        { forge: 'work', path: 'shapes/square' },
      ],
      listedAt: '2026-05-06T11:00:00.000Z',
      attempts: [],
    })
    await store.kv?.set('poll-group:colors', {
      repos: [{ forge: 'work', path: 'colors/red' }],
      listedAt: '2026-05-06T11:00:00.000Z',
      attempts: [],
    })
    await addMetrics('coverage', { percent: 42, target: 60, files: 2, untested: 1 })
    await addMetrics('audit', {
      findings: 1,
      severities: { critical: 1, high: 0, medium: 0, low: 0, unknown: 0 },
      ignored: 0,
      expired: 0,
      resolved: 0,
    })
    const known = [
      ...analyzers,
      { kind: 'coverage', scope: 'repo' as const, options: z.object({}) },
      { kind: 'audit', scope: 'repo' as const, options: z.object({}) },
    ]
    const reader: Principal = {
      id: 'header:sam',
      name: 'Sam',
      provider: 'header',
      grants: [{ scope: { groups: ['shapes'] }, actions: ['analyses:read'] }],
    }
    const mcp = opsToolset(principalOpsAccess({ ...deps(), analyzers: known }, reader), now)
    const text = await call(mcp, 'fleet_health', {})
    expect(text).toContain('# 2 repositories: 1 failing, 1 not analysed')
    expect(text).toContain('- work:shapes/circle · groups shapes · failing · dependencies')
    expect(text).toContain(' · coverage 42% (below 60%) bad · ')
    expect(text).toContain('current records 2 of 2 · last analysed 2026-05-06T09:00:00.000Z')
    expect(text).toContain('- work:shapes/square · groups shapes · not analysed')
    expect(text).not.toContain('security')
    expect(text).not.toContain('release')
    expect(text).not.toContain('colors/red')
    expect(text).not.toContain('updates')
    expect(await call(mcp, 'fleet_health', { health: 'healthy' })).toBe(
      'No repository you may see matches.',
    )
    expect(await call(mcp, 'fleet_health', { query: 'square' })).not.toContain('circle')

    const agent = opsToolset(
      agentOpsAccess(
        { ...deps(), analyzers: known },
        { forge: 'work', path: 'shapes/circle', groups: ['shapes'] },
        reader,
      ),
      now,
    )
    const asked = await call(agent, 'fleet_health', {})
    expect(asked).not.toContain('security')
    expect(asked).not.toContain('colors/red')

    const nobody: Principal = { id: 'header:x', name: 'X', provider: 'header', grants: [] }
    expect(
      await call(opsToolset(principalOpsAccess(deps(), nobody), now), 'fleet_health', {}),
    ).toBe('No repository you may see matches.')
  })
})
