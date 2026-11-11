import { beforeEach, describe, expect, test } from 'bun:test'

import type { Principal } from '@holtkeeper/access'
import type { RegistryToolset } from '@holtkeeper/agent-tools'
import { type ArtifactStore, memoryArtifactStore } from '@holtkeeper/artifacts'
import { parseConfig } from '@holtkeeper/core'
import { createJobLog } from '@holtkeeper/jobs'
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
      ['why_job', true],
      ['analysis_status', true],
      ['budget_status', true],
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
      'why_job',
      'analysis_status',
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
      'why_job',
      'analysis_status',
    ])
  })
})
