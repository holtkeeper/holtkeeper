import { describe, expect, test } from 'bun:test'

import { at, attempt, quarter } from '../test/history.ts'
import { analyzeCiJobs, busySeconds, changePoint, stageOrder } from './analyze.ts'
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
    })
    expect(build?.changePoint?.sha).toStartWith('sha')
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
    expect(result.pipelines).toMatchObject({ count: 1, duration: { median: 130 } })
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

  test('weeks cover the window, jobs follow the stage order', () => {
    const result = analyzeCiJobs(quarter(), window, options)
    expect(result.weeks).toHaveLength(14)
    expect(result.stages).toEqual(['build', 'test'])
    expect(result.jobs.map((j) => j.name)).toEqual(['build', 'deploy', 'lint', 'test'])
    expect(result.jobs[0]?.weeks).toHaveLength(14)
    expect(result.jobs[0]?.weeks.at(-1)).toBe(160)
    expect(result.lastRunAt).toBe(at(89, 14))
  })

  test('the branch filter drops other refs', () => {
    const all = analyzeCiJobs(quarter(), window, options)
    const main = analyzeCiJobs(quarter(), window, { ...options, branch: 'main' })
    expect(all.pipelines.count).toBe(123)
    expect(all.pipelines.ref).toBeUndefined()
    expect(main.pipelines).toMatchObject({ ref: 'main', count: 90 })
  })

  test('headline numbers describe the default branch: time, success rate, queue, change', () => {
    const result = analyzeCiJobs(quarter(), { ...window, defaultBranch: 'main' }, options)
    expect(result.defaultBranch).toBe('main')
    expect(result.pipelines).toEqual({
      ref: 'main',
      count: 90,
      successRate: 90,
      duration: { samples: 81, median: 100, p90: 160 },
      queue: { samples: 271, median: 30, p90: 30 },
      change: 0,
    })
    expect(result.weeks.reduce((sum, w) => sum + w.pipelines, 0)).toBe(90)
    expect(result.weeks.at(-2)).toMatchObject({ median: 160, pipelines: 7 })
  })

  test('without pipelines on the default branch every ref counts', () => {
    const result = analyzeCiJobs(quarter(), { ...window, defaultBranch: 'trunk' }, options)
    expect(result.pipelines.ref).toBeUndefined()
    expect(result.pipelines.count).toBe(123)
  })

  test('stage order follows job ids within pipelines, not names', () => {
    const records = [1, 2, 3].flatMap((p) => [
      attempt('compile', at(p), 10, { pipelineId: p, jobId: p * 10 + 1, stage: 'prepare' }),
      attempt('unit', at(p), 10, { pipelineId: p, jobId: p * 10 + 2, stage: 'check' }),
      attempt('ship', at(p), 10, { pipelineId: p, jobId: p * 10 + 3, stage: 'ahead' }),
    ])
    expect(stageOrder(records)).toEqual(['prepare', 'check', 'ahead'])
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
