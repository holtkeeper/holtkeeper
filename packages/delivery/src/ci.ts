import type { JobRun, PipelineRun } from '@holtkeeper/forge'

import { distribution, median, round, weekOf, weeksOf, within } from './stats.ts'
import type { CiData, FailingJob, FlakyJob, JobTiming, PipelineWeek } from './types.ts'

/** How many jobs each job table keeps. */
const TOP = 10

const finished = (p: PipelineRun) =>
  p.status === 'success' || p.status === 'failed' || p.status === 'canceled'

const successRate = (pipelines: PipelineRun[]) => {
  const success = pipelines.filter((p) => p.status === 'success').length
  const failed = pipelines.filter((p) => p.status === 'failed').length
  return success + failed === 0 ? undefined : round((success / (success + failed)) * 100)
}

const seconds = (values: (number | undefined)[]) => values.filter((v) => v !== undefined)

function pipelineWeek(week: string, pipelines: PipelineRun[]): PipelineWeek {
  const done = pipelines.filter(finished)
  const duration = distribution(seconds(done.map((p) => p.durationSeconds)))
  const queue = median(seconds(done.map((p) => p.queuedSeconds)))
  const rate = successRate(done)
  return {
    week,
    pipelines: pipelines.length,
    ...(rate === undefined ? {} : { successRate: rate }),
    ...(duration.median === undefined ? {} : { durationMedian: duration.median }),
    ...(duration.p95 === undefined ? {} : { durationP95: duration.p95 }),
    ...(queue === undefined ? {} : { queueMedian: round(queue) }),
  }
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const group = groups.get(k)
    if (group) group.push(item)
    else groups.set(k, [item])
  }
  return groups
}

/** Jobs by median duration of successful attempts, slowest first. */
export function slowestJobs(jobs: JobRun[]): JobTiming[] {
  const passed = jobs.filter((j) => j.status === 'success' && j.durationSeconds !== undefined)
  return [...groupBy(passed, (j) => j.name)]
    .map(([name, runs]) => {
      const d = distribution(seconds(runs.map((r) => r.durationSeconds)))
      return {
        name,
        stage: runs[0]?.stage ?? '',
        runs: runs.length,
        median: d.median ?? 0,
        p95: d.p95 ?? 0,
      }
    })
    .toSorted((a, b) => b.median - a.median || a.name.localeCompare(b.name))
    .slice(0, TOP)
}

/**
 * Jobs that both fail and pass on the same code: an attempt failed and a retry in the same
 * pipeline passed, or pipelines of the same commit ended the job differently.
 */
export function flakyJobs(jobs: JobRun[], pipelines: PipelineRun[]): FlakyJob[] {
  const shaOf = new Map(pipelines.map((p) => [p.id, p.sha]))
  const result: FlakyJob[] = []
  for (const [name, runs] of groupBy(jobs, (j) => j.name)) {
    let retriedThenPassed = 0
    for (const attempts of groupBy(runs, (r) => String(r.pipelineId)).values()) {
      const ordered = attempts.toSorted((a, b) => a.id - b.id)
      const firstFailure = ordered.findIndex((a) => a.status === 'failed')
      if (
        firstFailure !== -1 &&
        ordered.slice(firstFailure + 1).some((a) => a.status === 'success')
      )
        retriedThenPassed++
    }
    const finals = runs.filter((r) => !r.retried && shaOf.has(r.pipelineId))
    let alternatingShas = 0
    for (const sameSha of groupBy(finals, (r) => shaOf.get(r.pipelineId) ?? '').values()) {
      const statuses = new Set(sameSha.map((r) => r.status))
      if (statuses.has('success') && statuses.has('failed')) alternatingShas++
    }
    const occurrences = retriedThenPassed + alternatingShas
    if (occurrences > 0)
      result.push({
        name,
        stage: runs[0]?.stage ?? '',
        retriedThenPassed,
        alternatingShas,
        occurrences,
      })
  }
  return result
    .toSorted((a, b) => b.occurrences - a.occurrences || a.name.localeCompare(b.name))
    .slice(0, TOP)
}

/** Jobs whose final attempt failed most often; jobs allowed to fail are left out. */
export function failingJobs(jobs: JobRun[]): FailingJob[] {
  const finals = jobs.filter(
    (j) => !j.retried && !j.allowFailure && (j.status === 'success' || j.status === 'failed'),
  )
  return [...groupBy(finals, (j) => j.name)]
    .map(([name, runs]) => {
      const failures = runs.filter((r) => r.status === 'failed').length
      return {
        name,
        stage: runs[0]?.stage ?? '',
        failures,
        runs: runs.length,
        failureRate: round((failures / runs.length) * 100),
      }
    })
    .filter((j) => j.failures > 0)
    .toSorted(
      (a, b) =>
        b.failures - a.failures || b.failureRate - a.failureRate || a.name.localeCompare(b.name),
    )
    .slice(0, TOP)
}

/** Pipeline success, duration and queue statistics in the window, and job hot spots. */
export function computeCi(input: {
  from: string
  to: string
  pipelines: PipelineRun[]
  jobs: JobRun[]
  jobPipelines: number
}): CiData {
  const pipelines = input.pipelines.filter((p) => within(p.createdAt, input.from, input.to))
  const done = pipelines.filter(finished)
  const rate = successRate(done)
  const byWeek = groupBy(pipelines, (p) => weekOf(p.createdAt))
  return {
    pipelines: pipelines.length,
    finished: done.length,
    ...(rate === undefined ? {} : { successRate: rate }),
    duration: distribution(seconds(done.map((p) => p.durationSeconds))),
    queue: distribution(seconds(done.map((p) => p.queuedSeconds))),
    weeks: weeksOf(input.from, input.to).map((week) => pipelineWeek(week, byWeek.get(week) ?? [])),
    jobPipelines: input.jobPipelines,
    slowestJobs: slowestJobs(input.jobs),
    flakyJobs: flakyJobs(input.jobs, input.pipelines),
    failingJobs: failingJobs(input.jobs),
  }
}
