import { describe, expect, test } from 'bun:test'

import { at, attempt, quarter } from '../test/history.ts'
import { analyzeCiJobs, changePoint } from './analyze.ts'
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

  test('pipeline wall time spans the first job start to the last job end', () => {
    const records = [
      attempt('build', at(1), 100, { pipelineId: 1 }),
      attempt('test', at(1), 50, {
        pipelineId: 1,
        startedAt: at(1, 1),
        finishedAt: new Date(Date.parse(at(1, 1)) + 50_000).toISOString(),
      }),
    ]
    const result = analyzeCiJobs(records, window, options)
    expect(result.totals.wallTime.median).toBe(3590)
    expect(result.totals.pipelines).toBe(1)
  })

  test('weeks cover the window, jobs are ordered by CI time', () => {
    const result = analyzeCiJobs(quarter(), window, options)
    expect(result.weeks).toHaveLength(14)
    expect(result.weeks.reduce((sum, w) => sum + w.runs, 0)).toBe(result.totals.runs)
    expect(result.jobs.map((j) => j.name)).toEqual(['build', 'test', 'lint'])
    expect(result.jobs[0]?.weeks).toHaveLength(14)
    const share = result.jobs.reduce((sum, j) => sum + j.computeShare, 0)
    expect(Math.round(share)).toBe(100)
    expect(result.stages.map((s) => s.stage)).toEqual(['build', 'test'])
  })

  test('the branch filter drops other refs', () => {
    const all = analyzeCiJobs(quarter(), window, options)
    const main = analyzeCiJobs(quarter(), window, { ...options, branch: 'main' })
    expect(all.totals.pipelines).toBe(120)
    expect(main.totals.pipelines).toBe(90)
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
