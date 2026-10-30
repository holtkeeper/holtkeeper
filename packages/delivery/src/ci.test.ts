import { describe, expect, test } from 'bun:test'

import { at, job, pipeline } from '../test/history.ts'
import { computeCi, failingJobs, flakyJobs, slowestJobs } from './ci.ts'

describe('pipelines', () => {
  test('success rate, durations, queue and weekly trend', () => {
    const pipelines = [
      pipeline('success', at(1), { durationSeconds: 100, queuedSeconds: 10 }),
      pipeline('success', at(2), { durationSeconds: 200, queuedSeconds: 20 }),
      pipeline('failed', at(3), { durationSeconds: 300, queuedSeconds: 30 }),
      pipeline('canceled', at(8), { durationSeconds: 50 }),
      pipeline('success', at(9), { durationSeconds: 400 }),
      pipeline('running', at(10)),
      pipeline('success', at(-3), { durationSeconds: 9999 }),
    ]
    const ci = computeCi({ from: at(0), to: at(28), pipelines, jobs: [], jobPipelines: 0 })
    expect(ci.pipelines).toBe(6)
    expect(ci.finished).toBe(5)
    expect(ci.successRate).toBe(75)
    expect(ci.duration.median).toBe(200)
    expect(ci.duration.p95).toBe(380)
    expect(ci.queue.median).toBe(20)
    expect(ci.weeks[0]).toEqual({
      week: '2026-03-02',
      pipelines: 3,
      successRate: 66.67,
      durationMedian: 200,
      durationP95: 290,
      queueMedian: 20,
    })
    expect(ci.weeks[1]).toMatchObject({ pipelines: 3, successRate: 100, durationMedian: 225 })
    expect(ci.weeks[2]).toEqual({ week: '2026-03-16', pipelines: 0 })
  })
})

describe('jobs', () => {
  test('slowest jobs by median duration of successful attempts', () => {
    const jobs = [
      job(1, 'build', 'success', { durationSeconds: 60 }),
      job(2, 'build', 'success', { durationSeconds: 120 }),
      job(3, 'build', 'failed', { durationSeconds: 900 }),
      job(1, 'e2e', 'success', { durationSeconds: 600, stage: 'e2e' }),
      job(1, 'lint', 'success', { durationSeconds: 5 }),
    ]
    expect(slowestJobs(jobs)).toEqual([
      { name: 'e2e', stage: 'e2e', runs: 1, median: 600, p95: 600 },
      { name: 'build', stage: 'test', runs: 2, median: 90, p95: 117 },
      { name: 'lint', stage: 'test', runs: 1, median: 5, p95: 5 },
    ])
  })

  test('flaky: passed on retry, or mixed results for the same commit', () => {
    const pipelines = [
      pipeline('success', at(1), { id: 1, sha: 'a' }),
      pipeline('failed', at(1), { id: 2, sha: 'b' }),
      pipeline('success', at(2), { id: 3, sha: 'b' }),
      pipeline('success', at(3), { id: 4, sha: 'c' }),
    ]
    const jobs = [
      job(1, 'unit', 'failed', { id: 10, retried: true }),
      job(1, 'unit', 'success', { id: 11 }),
      job(2, 'e2e', 'failed', { id: 20 }),
      job(3, 'e2e', 'success', { id: 30 }),
      job(4, 'unit', 'success', { id: 40, retried: true }),
      job(4, 'unit', 'failed', { id: 41 }),
      job(4, 'lint', 'success', { id: 42 }),
    ]
    expect(flakyJobs(jobs, pipelines)).toEqual([
      { name: 'e2e', stage: 'test', retriedThenPassed: 0, alternatingShas: 1, occurrences: 1 },
      { name: 'unit', stage: 'test', retriedThenPassed: 1, alternatingShas: 0, occurrences: 1 },
    ])
  })

  test('failing jobs count final attempts and skip allowed failures', () => {
    const jobs = [
      job(1, 'unit', 'failed', { retried: true }),
      job(1, 'unit', 'success'),
      job(2, 'unit', 'failed'),
      job(3, 'unit', 'failed'),
      job(3, 'audit', 'failed', { allowFailure: true }),
      job(3, 'deploy', 'manual'),
      job(4, 'e2e', 'failed'),
      job(5, 'e2e', 'success'),
    ]
    expect(failingJobs(jobs)).toEqual([
      { name: 'unit', stage: 'test', failures: 2, runs: 3, failureRate: 66.67 },
      { name: 'e2e', stage: 'test', failures: 1, runs: 2, failureRate: 50 },
    ])
  })
})
