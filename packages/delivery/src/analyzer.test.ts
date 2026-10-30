import { describe, expect, test } from 'bun:test'

import { fakeForge } from '../test/fake-forge.ts'
import { at, deployment, job, mr, pipeline, tag } from '../test/history.ts'
import { deliveryDataSchema } from './analyze.ts'
import { createDeliveryAnalyzer, deliveryOptionsSchema } from './analyzer.ts'

const now = () => new Date(at(28))
const repo = { forge: 'gitlab', path: 'g/a' }
const runner = { run: () => Promise.reject(new Error('the delivery analyzer runs no commands')) }

const history = () => ({
  mergeRequests: [
    mr({ createdAt: at(1), mergedAt: at(1, 4) }),
    mr({ createdAt: at(-60), state: 'open', updatedAt: at(-50) }),
  ],
  deployments: [
    deployment('success', at(2)),
    deployment('success', at(9)),
    deployment('success', at(5), { environment: 'staging' }),
  ],
  tags: [tag('v1.0.0', at(3))],
  pipelines: [
    pipeline('success', at(2), { id: 1, durationSeconds: 60 }),
    pipeline('running', at(27), { id: 2 }),
  ],
  jobs: [job(1, 'unit', 'success', { durationSeconds: 30 }), job(2, 'unit', 'running')],
})

async function run(forge: ReturnType<typeof fakeForge>, options: Record<string, unknown> = {}) {
  const analyzer = createDeliveryAnalyzer({ now })
  return analyzer.run({ repo, forge, runner, options: deliveryOptionsSchema.parse(options) })
}

describe('delivery analyzer', () => {
  test('declares scope, needs and defaults', () => {
    const analyzer = createDeliveryAnalyzer()
    expect(analyzer.kind).toBe('delivery')
    expect(analyzer.scope).toBe('repo')
    expect(analyzer.needs).toEqual({ forge: true })
    expect(deliveryOptionsSchema.parse({ days: '30' })).toMatchObject({
      days: 30,
      productionEnvironment: 'production',
      failureWindowHours: 24,
      staleDays: 7,
    })
  })

  test('collects history through the forge and produces valid data', async () => {
    const forge = fakeForge(history())
    const { data } = await run(forge, { days: 28 })
    expect(deliveryDataSchema.parse(data)).toEqual(data)
    expect(data.window).toEqual({ from: at(0), to: at(28), days: 28 })
    expect(data.dora.source).toBe('deployments')
    expect(data.dora.deployments).toBe(2)
    expect(data.dora.leadTime.median).toBe(24 * 3600)
    expect(data.mergeRequests.stale.map((s) => s.idleDays)).toEqual([78])
    expect(data.ci.jobPipelines).toBe(1)
    expect(data.counts.jobs).toBe(1)
    expect(forge.calls).toContain('deployments production')
    expect(forge.calls).toContain('mergeRequests open')
    expect(forge.calls).not.toContain('jobs 2')
  })

  test('falls back to tags and notes missing reads', async () => {
    const forge = fakeForge(history(), ['listDeployments', 'listJobRuns'])
    const { data } = await run(forge, { days: 28 })
    expect(data.dora.source).toBe('tags')
    expect(data.notes.join('\n')).toContain('does not provide listDeployments')
    expect(data.notes.join('\n')).toContain('does not provide listJobRuns')
    expect(data.notes.join('\n')).toContain('tags count as releases')
    expect(data.ci.jobPipelines).toBe(0)
  })

  test('rejects without a forge', async () => {
    const analyzer = createDeliveryAnalyzer({ now })
    const error = await analyzer
      .run({ repo, runner, options: deliveryOptionsSchema.parse({}) })
      .catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain('needs a forge')
  })
})
