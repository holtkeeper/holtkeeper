import { describe, expect, test } from 'bun:test'

import type { Block } from '@holtkeeper/report'

import { at, deployment, input, job, mr, options, pipeline } from '../test/history.ts'
import { analyzeDelivery } from './analyze.ts'
import { deliveryAnalysis, deliveryReport } from './report.ts'

const record = (data: ReturnType<typeof analyzeDelivery>, id: string) => ({
  id,
  repo: { forge: 'gitlab', path: 'g/a' },
  kind: 'delivery',
  createdAt: data.window.to,
  data,
})

function current() {
  return analyzeDelivery(
    input({
      deployments: [0, 7, 14, 21].map((d) => deployment('success', at(d, 12))),
      mergeRequests: [
        mr({ id: 1, createdAt: at(0), mergedAt: at(0, 6) }),
        mr({ id: 2, createdAt: at(1), state: 'open', updatedAt: at(2), title: 'old work' }),
        mr({ id: 3, createdAt: at(1), state: 'open', updatedAt: at(3), draft: true }),
      ],
      pipelines: [
        pipeline('success', at(1), { id: 1, durationSeconds: 120 }),
        pipeline('failed', at(2), { id: 2, durationSeconds: 60 }),
      ],
      jobs: [
        job(1, 'unit', 'failed', { retried: true }),
        job(1, 'unit', 'success', { durationSeconds: 40 }),
      ],
      jobPipelines: 2,
    }),
    options,
  )
}

function previousData() {
  return analyzeDelivery(
    input({
      deployments: [0, 14].map((d) => deployment('success', at(d, 12))),
      mergeRequests: [
        mr({ id: 2, createdAt: at(1), state: 'open', updatedAt: at(2) }),
        mr({ id: 9, createdAt: at(1), state: 'open', updatedAt: at(2) }),
      ],
      pipelines: [pipeline('success', at(1), { durationSeconds: 300 })],
      jobs: [job(5, 'lint', 'failed', { retried: true }), job(5, 'lint', 'success')],
      jobPipelines: 1,
    }),
    options,
  )
}

const blocksOf = (report: ReturnType<typeof deliveryReport>, id: string) =>
  report.sections.find((s) => s.id === id)?.blocks ?? []

const table = (blocks: Block[], title: string) => {
  const block = blocks.find((b) => b.type === 'table' && b.title === title)
  if (block?.type !== 'table') throw new Error(`no table ${title}`)
  return block
}

describe('delivery report', () => {
  test('headline metrics carry deltas and band tones', () => {
    const report = deliveryReport(current(), { previous: previousData() })
    const byId = new Map(report.metrics.map((m) => [m.id, m]))
    expect(byId.get('deployment-frequency')).toMatchObject({
      value: 1,
      delta: 0.5,
      better: 'up',
      tone: 'info',
    })
    expect(byId.get('lead-time')).toMatchObject({
      value: 12 * 3600 * 1000,
      unit: 'ms',
      tone: 'good',
    })
    expect(byId.get('change-failure-rate')).toMatchObject({
      value: 0,
      unit: 'percent',
      tone: 'good',
    })
    expect(byId.get('time-to-restore')).toMatchObject({ value: 'n/a', unit: 'text' })
    expect(byId.get('pipeline-success')).toMatchObject({ value: 50, delta: -50 })
    expect(byId.get('pipeline-duration')).toMatchObject({ value: 90_000, delta: -210_000 })
    expect(byId.get('flaky-jobs')).toMatchObject({ value: 1, delta: 0, tone: 'warning' })
    expect(byId.get('stale-merge-requests')).toMatchObject({ value: 2, delta: 0 })
    expect(report.sections.map((s) => s.title)).toEqual([
      'DORA',
      'Pipelines',
      'Merge requests',
      'Notes',
    ])
  })

  test('marks new and resolved stale merge requests and flaky jobs', () => {
    const report = deliveryReport(current(), { previous: previousData() })
    const mrs = blocksOf(report, 'merge-requests')
    const stale = table(mrs, 'Stale merge requests')
    expect(stale.rows.map((r) => [r['title'], r['status']])).toEqual([
      [{ text: '!2 old work', href: 'https://g.example/g/a/-/merge_requests/2' }, ''],
      [
        { text: '!3 change 3', href: 'https://g.example/g/a/-/merge_requests/3', hint: 'Draft' },
        { text: 'new', tone: 'warning' },
      ],
    ])
    expect(mrs.at(-1)).toEqual({
      type: 'markdown',
      text: 'No longer stale (merged, closed or updated): !9.',
    })

    const pipelines = blocksOf(report, 'pipelines')
    expect(table(pipelines, 'Flaky jobs').rows[0]).toMatchObject({
      name: 'unit',
      status: { text: 'new', tone: 'warning' },
    })
    expect(pipelines.at(-1)).toEqual({ type: 'markdown', text: 'No longer flaky: `lint`.' })
  })

  test('weekly DORA chart and notes about the source', () => {
    const report = deliveryReport(current())
    const chart = blocksOf(report, 'dora').find((b) => b.type === 'chart')
    expect(chart).toMatchObject({ chart: 'stacked-bar', x: 'week' })
    if (chart?.type === 'chart') expect(chart.data.map((d) => d['ok'])).toEqual([1, 1, 1, 1, 0])
    const notes = blocksOf(report, 'notes')[0]
    expect(notes?.type === 'markdown' && notes.text).toContain(
      'deployments to the production environment',
    )
  })

  test('the analysis kind validates data and builds reports from records', () => {
    const data = current()
    expect(deliveryAnalysis.schema.parse(JSON.parse(JSON.stringify(data)))).toEqual(data)
    const report = deliveryAnalysis.toReport(record(data, 'b'), record(previousData(), 'a'))
    expect(report.kind).toBe('delivery')
    expect(report.subject?.repo).toEqual({ forge: 'gitlab', path: 'g/a' })
    expect(report.metrics.find((m) => m.id === 'deployment-frequency')?.delta).toBe(0.5)
    expect(deliveryAnalysis.summarize(data).every((m) => m.delta === undefined)).toBe(true)
  })
})
