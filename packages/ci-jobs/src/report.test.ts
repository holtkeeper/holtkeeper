import { describe, expect, test } from 'bun:test'

import type { Block } from '@holtkeeper/report'

import { at, quarter } from '../test/history.ts'
import { analyzeCiJobs } from './analyze.ts'
import { ciJobsAnalysis, ciJobsReport } from './report.ts'
import type { CiJobsData } from './types.ts'

const data = (records = quarter()): CiJobsData => ({
  ...analyzeCiJobs(
    records,
    { from: at(0), to: at(90), defaultBranch: 'main' },
    { days: 90, recentDays: 14, changePercent: 20, minChangeSeconds: 15 },
  ),
  history: { oldest: at(0), newest: at(89), jobs: 301, syncedFrom: at(0) },
})

const blocks = (sectionId: string, current = data()) =>
  ciJobsReport(current).sections.find((s) => s.id === sectionId)?.blocks ?? []

const ofType = <T extends Block['type']>(list: Block[], type: T) =>
  list.filter((b): b is Extract<Block, { type: T }> => b.type === type)

const record = (payload: unknown) => ({
  id: 'a',
  repo: { forge: 'gitlab', path: 'g/a' },
  kind: 'ci-jobs',
  createdAt: at(90),
  data: payload as CiJobsData,
})

describe('ciJobsReport', () => {
  test('three headline numbers with deltas against the previous record', () => {
    const current = data()
    const previous = {
      ...current,
      pipelines: { ...current.pipelines, successRate: 80 },
    }
    const report = ciJobsReport(current, { previous })
    expect(report.metrics.map((m) => m.id)).toEqual(['pipeline-time', 'success-rate', 'queue'])
    const byId = Object.fromEntries(report.metrics.map((m) => [m.id, m]))
    expect(byId['pipeline-time']).toMatchObject({ value: 100_000, unit: 'ms', better: 'down' })
    expect(byId['success-rate']).toMatchObject({ value: 90, delta: 10, better: 'up' })
  })

  test('sections mirror the CI page', () => {
    expect(ciJobsReport(data()).sections.map((s) => s.id)).toEqual([
      'problems',
      'pipeline-time',
      'jobs',
      'reliability',
    ])
    const [issues] = ofType(blocks('problems'), 'issues')
    expect(issues?.items.map((i) => i.title)).toEqual([
      'test: fails in 10% of runs',
      'build: +60% since 14 Sep (1m 40s → 2m 40s)',
    ])
    const [chart] = ofType(blocks('pipeline-time'), 'chart')
    expect(chart?.data).toHaveLength(14)
    expect(chart?.series.map((s) => s.key)).toEqual(['median', 'p90'])
  })

  test('the jobs table carries weekly sparklines', () => {
    const [table] = ofType(blocks('jobs'), 'table')
    const build = table?.rows.find(
      (r) => typeof r['job'] === 'object' && r['job']?.text === 'build',
    )
    const medianCell = build?.['median']
    expect(medianCell).toMatchObject({ text: '1m 40s', value: 100_000, tone: 'bad' })
    expect(typeof medianCell === 'object' && medianCell?.series).toHaveLength(14)
  })

  test('a quiet window says so', () => {
    expect(ofType(blocks('problems', data([])), 'markdown')).toHaveLength(1)
    expect(ofType(blocks('reliability', data([])), 'markdown')).toHaveLength(1)
  })

  test('the analysis kind validates data and drops fields it no longer keeps', () => {
    const current = data()
    expect(ciJobsAnalysis.schema.parse(current)).toEqual(current)
    const extra = { ...current, notes: ['old'], refGroups: [], totals: { runs: 1 } }
    expect(ciJobsAnalysis.schema.parse(extra)).toEqual(current)
    expect(ciJobsAnalysis.toReport(record(extra)).sections).toHaveLength(4)
  })

  test('records in an older shape neither crash lists nor reports', () => {
    const old = { window: { from: at(0), to: at(90), days: 90 }, totals: { runs: 3 }, stages: [] }
    expect(ciJobsAnalysis.summarize(old as never)).toEqual([])
    const report = ciJobsAnalysis.toReport(record(old))
    expect(report.sections.map((s) => s.id)).toEqual(['outdated'])
    expect(ciJobsAnalysis.toReport(record(data()), record(old)).metrics[0]?.delta).toBeUndefined()
  })
})
