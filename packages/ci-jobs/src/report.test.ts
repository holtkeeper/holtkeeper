import { describe, expect, test } from 'bun:test'

import type { Block } from '@holtkeeper/report'

import { at, quarter } from '../test/history.ts'
import { analyzeCiJobs } from './analyze.ts'
import { ciJobsAnalysis, ciJobsReport } from './report.ts'
import type { CiJobsData } from './types.ts'

const data = (records = quarter(), branch: string | null = 'main'): CiJobsData => ({
  ...analyzeCiJobs(
    records,
    { from: at(0), to: at(90), defaultBranch: 'main' },
    {
      days: 90,
      ...(branch ? { branch } : {}),
      recentDays: 14,
      changePercent: 20,
      minChangeSeconds: 15,
    },
  ),
  history: { oldest: at(0), newest: at(89), jobs: 301, syncedFrom: at(0) },
  sync: { mode: 'incremental', after: at(88), fetched: 6, stored: 6 },
  notes: [],
})

const blocks = (sectionId: string, current = data()) =>
  ciJobsReport(current).sections.find((s) => s.id === sectionId)?.blocks ?? []

const ofType = <T extends Block['type']>(list: Block[], type: T) =>
  list.filter((b): b is Extract<Block, { type: T }> => b.type === type)

describe('ciJobsReport', () => {
  test('headline metrics with deltas against the previous record', () => {
    const current = data()
    const previous = { ...current, totals: { ...current.totals, slowerJobs: 0, failureRate: 10 } }
    const report = ciJobsReport(current, { previous })
    const byId = Object.fromEntries(report.metrics.map((m) => [m.id, m]))
    expect(byId['slower-jobs']).toMatchObject({ value: 1, delta: 1, tone: 'bad', better: 'down' })
    expect(byId['failure-rate']).toMatchObject({
      unit: 'percent',
      delta: current.totals.failureRate! - 10,
    })
    expect(byId['wall-time']).toMatchObject({ unit: 'ms', better: 'down' })
    expect(report.subtitle).toBe('Last 90 days on main')
  })

  test('slowdowns name the commit and chart the job with a marker', () => {
    const list = blocks('shifts')
    const [issues] = ofType(list, 'issues')
    expect(issues?.items[0]?.title).toBe('build is 60% slower: 1m 40s → 2m 40s')
    expect(issues?.items[0]?.detail).toContain('Since 2026-09-14 (commit sha')
    const [chart] = ofType(list, 'chart')
    expect(chart).toMatchObject({ chart: 'line', bands: [{ low: 'p25', high: 'p75' }] })
    expect(chart?.markers?.[0]?.x).toBe('Sep 14')
  })

  test('the jobs table carries weekly sparklines and sortable values', () => {
    const [table] = ofType(blocks('jobs'), 'table')
    const build = table?.rows.find(
      (r) => typeof r['job'] === 'object' && r['job']?.text === 'build',
    )
    const medianCell = build?.['median']
    expect(medianCell).toMatchObject({ text: '1m 40s', value: 100_000, tone: 'bad' })
    expect(typeof medianCell === 'object' && medianCell?.series).toHaveLength(14)
    expect(build?.['change']).toMatchObject({ text: '+60%', value: 60 })
  })

  test('heatmaps compare weeks with the job’s own median and show failure rates', () => {
    const [durations, failures] = ofType(blocks('heatmaps'), 'heatmap')
    expect(durations?.xLabels).toHaveLength(14)
    const build = durations?.yRows.find((r) => r.label === 'build')
    expect(build?.cells.at(-1)).toMatchObject({ value: 60, text: '2m 40s (+60% vs 1m 40s)' })
    expect(failures?.yRows.map((r) => r.label)).toEqual(['test'])
    expect(failures?.scale).toEqual({ kind: 'sequential', tone: 'bad' })
  })

  test('pipelines by branch: groups with weekly sparklines and a line per group', () => {
    const list = blocks('refs', data(quarter(), null))
    const [groups, refs] = ofType(list, 'table')
    expect(groups?.rows.map((r) => r['pipelines'])).toEqual([90, 30, 3])
    expect(groups?.rows[0]?.['group']).toMatchObject({ text: 'Main branches (default: main)' })
    expect(groups?.rows[0]?.['change']).toMatchObject({ text: '+60%', tone: 'bad' })
    const [chart] = ofType(list, 'chart')
    expect(chart?.series.map((s) => s.key)).toEqual(['main', 'feature', 'tag'])
    expect(chart?.data).toHaveLength(14)
    expect(refs?.rows.map((r) => r['ref'])).toEqual([
      'main',
      'feature',
      'v1.29.0',
      'v1.59.0',
      'v1.89.0',
    ])
    expect(ciJobsReport(data()).metrics[0]).toMatchObject({
      id: 'main-branch-time',
      value: 100_000,
    })
  })

  test('a quiet window says so instead of listing shifts', () => {
    const list = blocks('shifts', data([]))
    expect(ofType(list, 'markdown')[0]?.text).toContain('No job changed its median')
    expect(ofType(blocks('reliability', data([])), 'markdown')).toHaveLength(1)
  })

  test('the analysis kind validates data and renders records', () => {
    const current = data()
    expect(ciJobsAnalysis.schema.parse(current)).toEqual(current)
    const report = ciJobsAnalysis.toReport({
      id: 'a',
      repo: { forge: 'gitlab', path: 'g/a' },
      kind: 'ci-jobs',
      createdAt: at(90),
      data: current,
    })
    expect(report.sections.map((s) => s.id)).toEqual([
      'shifts',
      'pipelines',
      'refs',
      'jobs',
      'heatmaps',
      'reliability',
      'notes',
    ])
  })
})
