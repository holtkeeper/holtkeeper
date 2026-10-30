import { describe, expect, test } from 'bun:test'

import { at, attempt, quarter } from '../test/history.ts'
import { analyzeCiJobs, busySeconds, changePoint } from './analyze.ts'
import type { CiJobsOptions } from './types.ts'

const options: CiJobsOptions = { days: 90, recentDays: 14, changePercent: 20, minChangeSeconds: 15 }
const window = { from: at(0), to: at(90) }

describe('analyzeCiJobs', () => {
  test('finds the slower job, when it changed and on which commit', () => {
    const result = analyzeCiJobs(quarter(), window, { ...options, branch: 'main' })
    const build = result.jobs.find((j) => j.name === 'build')
    expect(build).toMatchObject({
      trend: 'slower',
      baselineMedian: 100,
      recentMedian: 160,
      change: 60,
      runs: 90,
    })
    expect(build?.changePoint).toMatchObject({
      at: at(75, 10),
      before: 100,
      after: 160,
      ref: 'main',
    })
    expect(build?.changePoint?.sha).toStartWith('sha')
    expect(result.totals).toMatchObject({ slowerJobs: 1, fasterJobs: 0 })
  })

  test('failure rates count final attempts and leave out jobs allowed to fail', () => {
    const result = analyzeCiJobs(quarter(), window, { ...options, branch: 'main' })
    const testJob = result.jobs.find((j) => j.name === 'test')
    expect(testJob).toMatchObject({
      trend: 'stable',
      runs: 91,
      pipelines: 90,
      failures: 9,
      failureRate: 10,
      flaky: 1,
      retryRate: 1.1,
    })
    const lint = result.jobs.find((j) => j.name === 'lint')
    expect(lint).toMatchObject({ allowFailure: true, failures: 0 })
    expect(lint?.failureRate).toBeUndefined()
    expect(result.totals.failures).toBe(9)
    expect(result.totals.failureRate).toBe(5)
    expect(result.totals.flakyJobs).toBe(1)
  })

  test('pipeline time counts when jobs ran, not the gap before a late manual job', () => {
    const records = [
      attempt('build', at(1), 100, { pipelineId: 1 }),
      attempt('test', at(1), 50, { pipelineId: 1 }),
      attempt('deploy', at(1), 30, {
        pipelineId: 1,
        startedAt: at(8),
        finishedAt: new Date(Date.parse(at(8)) + 30_000).toISOString(),
      }),
    ]
    const result = analyzeCiJobs(records, window, options)
    expect(result.totals.wallTime.median).toBe(130)
    expect(result.totals.pipelines).toBe(1)
  })

  test('busySeconds merges overlaps and skips gaps', () => {
    expect(
      busySeconds([
        [0, 10_000],
        [5_000, 20_000],
        [100_000, 110_000],
        [101_000, 102_000],
      ]),
    ).toBe(30)
    expect(busySeconds([])).toBe(0)
  })

  test('weeks cover the window, jobs are ordered by CI time', () => {
    const result = analyzeCiJobs(quarter(), window, options)
    expect(result.weeks).toHaveLength(14)
    expect(result.weeks.reduce((sum, w) => sum + w.runs, 0)).toBe(result.totals.runs)
    expect(result.jobs.map((j) => j.name)).toEqual(['build', 'test', 'deploy', 'lint'])
    expect(result.jobs[0]?.weeks).toHaveLength(14)
    const share = result.jobs.reduce((sum, j) => sum + j.computeShare, 0)
    expect(Math.round(share)).toBe(100)
    expect(result.stages.map((s) => s.stage)).toEqual(['build', 'test'])
  })

  test('the branch filter drops other refs', () => {
    const all = analyzeCiJobs(quarter(), window, options)
    const main = analyzeCiJobs(quarter(), window, { ...options, branch: 'main' })
    expect(all.totals.pipelines).toBe(123)
    expect(main.totals.pipelines).toBe(90)
  })

  test('pipeline time per kind of ref, durations from passing pipelines', () => {
    const result = analyzeCiJobs(quarter(), { ...window, defaultBranch: 'main' }, options)
    expect(result.defaultBranch).toBe('main')
    expect(result.refGroups.map((g) => [g.group, g.pipelines, g.refs])).toEqual([
      ['main', 90, 1],
      ['feature', 30, 1],
      ['tag', 3, 3],
    ])
    const main = result.refGroups[0]
    expect(main?.label).toBe('Main branches (default: main)')
    expect(main?.hasDefault).toBe(true)
    expect(main?.failureRate).toBe(10)
    expect(main?.baselineMedian).toBe(100)
    expect(main?.recentMedian).toBe(160)
    expect(main?.change).toBe(60)
    expect(main?.weeks).toHaveLength(14)
    expect(result.refGroups[2]?.duration.median).toBe(600)
    expect(result.refGroups[2]?.topRefs.map((r) => r.ref)).toEqual([
      'v1.29.0',
      'v1.59.0',
      'v1.89.0',
    ])
  })

  test('new and idle jobs, and small changes that stay stable', () => {
    const records = [
      ...Array.from({ length: 10 }, (_, day) => attempt('old', at(day), 30)),
      ...Array.from({ length: 10 }, (_, i) => attempt('fresh', at(80 + i), 30)),
      ...Array.from({ length: 10 }, (_, day) => attempt('tiny', at(day * 9), day >= 9 ? 12 : 10)),
    ]
    const jobs = analyzeCiJobs(records, window, options).jobs
    expect(jobs.find((j) => j.name === 'old')?.trend).toBe('idle')
    expect(jobs.find((j) => j.name === 'fresh')?.trend).toBe('new')
    expect(jobs.find((j) => j.name === 'tiny')?.trend).toBe('stable')
  })
})

describe('changePoint', () => {
  test('needs three days each side', () => {
    const runs = Array.from({ length: 5 }, (_, day) => attempt('a', at(day), day > 2 ? 100 : 10))
    expect(changePoint(runs, 1)).toBeUndefined()
  })

  test('finds a speedup in the faster direction only', () => {
    const runs = Array.from({ length: 10 }, (_, day) => attempt('a', at(day), day >= 4 ? 20 : 80))
    expect(changePoint(runs, -1)).toMatchObject({ at: at(4), before: 80, after: 20 })
    expect(changePoint(runs, 1)).toBeUndefined()
  })
})
