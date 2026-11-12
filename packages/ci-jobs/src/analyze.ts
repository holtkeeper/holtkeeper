import type { CiJobRecord } from '@holtkeeper/store'

import { addDays, groupBy, median, percent, round, spread, weekOf, weeksOf } from './stats.ts'
import type {
  ChangePoint,
  CiJobsData,
  CiOutcomes,
  CiJobsOptions,
  JobStats,
  JobTrend,
  PipelineStats,
} from './types.ts'

/** Successful runs each side needs before a job can count as slower or faster. */
const MIN_SAMPLES = 5
/** Days with successful runs each side of a change point needs. */
const MIN_DAYS = 3

/** The parts of `CiJobsData` computed from stored job attempts alone. */
export type CiJobsAnalysis = Pick<
  CiJobsData,
  'window' | 'options' | 'defaultBranch' | 'lastRunAt' | 'pipelines' | 'weeks' | 'stages' | 'jobs'
>

const attemptKey = (r: CiJobRecord) => `${r.pipelineId}\u0000${r.name}`
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)
const mean = (values: readonly number[]) => (values.length ? sum(values) / values.length : 0)
const defined = (values: readonly (number | undefined)[]) =>
  values.filter((value) => value !== undefined)
const succeeded = (r: CiJobRecord) => r.status === 'success' && r.durationSeconds !== undefined
const seconds = (list: readonly CiJobRecord[]) => defined(list.map((r) => r.durationSeconds))
const byTime = (a: CiJobRecord, b: CiJobRecord) =>
  a.createdAt.localeCompare(b.createdAt) || a.jobId - b.jobId

/** Final attempts that count towards failure rates: not allowed to fail, not canceled. */
const counted = (finals: readonly CiJobRecord[]) =>
  finals.filter((r) => !r.allowFailure && r.status !== 'canceled')

/** Final attempts by how they ended. */
function jobOutcomes(finals: readonly CiJobRecord[]): CiOutcomes {
  const outcomes: CiOutcomes = { success: 0, failed: 0, canceled: 0 }
  for (const r of finals) outcomes[r.status]++
  return outcomes
}

/** Pipelines where an attempt failed and a later attempt of the same job passed. */
function flakyPipelines(runs: readonly CiJobRecord[]): number {
  let flaky = 0
  for (const attempts of groupBy(runs, (r) => String(r.pipelineId)).values()) {
    const ordered = attempts.toSorted((a, b) => a.jobId - b.jobId)
    const failed = ordered.findIndex((a) => a.status === 'failed')
    if (failed !== -1 && ordered.slice(failed + 1).some((a) => a.status === 'success')) flaky++
  }
  return flaky
}

/**
 * The day the job's duration moved most in `direction` (1 slower, -1 faster), comparing the
 * mean of daily medians before and after it, weighted towards balanced splits.
 */
export function changePoint(
  successes: readonly CiJobRecord[],
  direction: 1 | -1,
): ChangePoint | undefined {
  const days = [...groupBy(successes.toSorted(byTime), (r) => r.createdAt.slice(0, 10))]
  if (days.length < MIN_DAYS * 2) return undefined
  const daily = days.map(([, runs]) => median(defined(runs.map((r) => r.durationSeconds))) ?? 0)
  let best: { index: number; score: number } | undefined
  for (let k = MIN_DAYS; k <= days.length - MIN_DAYS; k++) {
    const shift = (mean(daily.slice(k)) - mean(daily.slice(0, k))) * direction
    const score = shift * Math.sqrt((k * (days.length - k)) / days.length)
    if (shift > 0 && (!best || score > best.score)) best = { index: k, score }
  }
  if (!best) return undefined
  const durations = (from: number, to?: number) =>
    days.slice(from, to).flatMap(([, runs]) => defined(runs.map((r) => r.durationSeconds)))
  const first = days[best.index]?.[1][0]
  if (!first) return undefined
  return {
    at: first.createdAt,
    before: round(median(durations(0, best.index)) ?? 0),
    after: round(median(durations(best.index)) ?? 0),
    ...(first.sha ? { sha: first.sha } : {}),
    href: first.webUrl,
  }
}

function trendOf(
  recent: readonly number[],
  baseline: readonly number[],
  options: CiJobsOptions,
): { trend: JobTrend; recentMedian?: number; baselineMedian?: number; change?: number } {
  const recentMedian = median(recent)
  const baselineMedian = median(baseline)
  const medians = {
    ...(recentMedian === undefined ? {} : { recentMedian: round(recentMedian) }),
    ...(baselineMedian === undefined ? {} : { baselineMedian: round(baselineMedian) }),
  }
  if (recentMedian === undefined) return { trend: 'idle', ...medians }
  if (baselineMedian === undefined) return { trend: 'new', ...medians }
  const change =
    baselineMedian > 0 ? round(((recentMedian - baselineMedian) / baselineMedian) * 100) : undefined
  const result = { ...medians, ...(change === undefined ? {} : { change }) }
  const shifted =
    recent.length >= MIN_SAMPLES &&
    baseline.length >= MIN_SAMPLES &&
    change !== undefined &&
    Math.abs(change) >= options.changePercent &&
    Math.abs(recentMedian - baselineMedian) >= options.minChangeSeconds
  if (!shifted) return { trend: 'stable', ...result }
  return { trend: recentMedian > baselineMedian ? 'slower' : 'faster', ...result }
}

function jobStats(
  name: string,
  runs: CiJobRecord[],
  context: {
    finals: ReadonlySet<CiJobRecord>
    weeks: readonly string[]
    recentFrom: string
    options: CiJobsOptions
  },
): JobStats {
  const ordered = runs.toSorted(byTime)
  const last = ordered.at(-1) ?? ordered[0]
  if (!last) throw new Error(`job ${name} has no runs`)
  const byPipeline = groupBy(ordered, (r) => String(r.pipelineId))
  const finals = ordered.filter((r) => context.finals.has(r))
  const considered = counted(finals)
  const failures = considered.filter((r) => r.status === 'failed').length
  const failureRate = percent(failures, considered.length)
  const successes = ordered.filter(succeeded)
  const recent = successes.filter((r) => r.createdAt >= context.recentFrom)
  const baseline = successes.filter((r) => r.createdAt < context.recentFrom)
  const trend = trendOf(seconds(recent), seconds(baseline), context.options)
  const point =
    trend.trend === 'slower' || trend.trend === 'faster'
      ? changePoint(successes, trend.trend === 'slower' ? 1 : -1)
      : undefined
  const byWeek = groupBy(successes, (r) => weekOf(r.createdAt))
  return {
    name,
    stage: last.stage,
    runs: ordered.length,
    pipelines: byPipeline.size,
    failures,
    ...(failureRate === undefined ? {} : { failureRate }),
    retryRate:
      percent([...byPipeline.values()].filter((a) => a.length > 1).length, byPipeline.size) ?? 0,
    flaky: flakyPipelines(ordered),
    outcomes: jobOutcomes(finals),
    allowFailure: last.allowFailure,
    duration: spread(seconds(successes)),
    ...trend,
    ...(point ? { changePoint: point } : {}),
    weeks: context.weeks.map((week) => {
      const mid = median(seconds(byWeek.get(week) ?? []))
      return mid === undefined ? null : round(mid)
    }),
    last: { at: last.createdAt, status: last.status, href: last.webUrl },
  }
}

interface PipelineSpan {
  createdAt: string
  ref?: string
  tag: boolean
  /** A final attempt of a job not allowed to fail failed. */
  failed: boolean
  /** Not failed, but such an attempt was canceled. */
  canceled: boolean
  /** Seconds at least one job ran, gaps left out; absent when a job lacks times. */
  wallSeconds?: number
  jobs: CiJobRecord[]
}

/**
 * Seconds covered by the union of `intervals` (milliseconds): overlapping jobs count once and
 * idle gaps, such as a manual job started days later, not at all.
 */
export function busySeconds(intervals: readonly [number, number][]): number {
  let total = 0
  let end = Number.NEGATIVE_INFINITY
  for (const [from, to] of intervals.toSorted((a, b) => a[0] - b[0])) {
    if (to <= end) continue
    total += to - Math.max(from, end)
    end = to
  }
  return total / 1000
}

function pipelineSpans(
  records: readonly CiJobRecord[],
  finals: ReadonlySet<CiJobRecord>,
): PipelineSpan[] {
  return [...groupBy(records, (r) => String(r.pipelineId)).values()].map((jobs) => {
    const createdAt = jobs.map((j) => j.createdAt).toSorted()[0] ?? ''
    const ref = jobs.find((j) => j.ref)?.ref
    const gating = jobs.filter((j) => finals.has(j) && !j.allowFailure)
    const failed = gating.some((j) => j.status === 'failed')
    const base = {
      createdAt,
      ...(ref ? { ref } : {}),
      tag: jobs.some((j) => j.tag),
      failed,
      canceled: !failed && gating.some((j) => j.status === 'canceled'),
      jobs,
    }
    const intervals = jobs.map((j): [number, number] => [
      j.startedAt ? Date.parse(j.startedAt) : Number.NaN,
      j.finishedAt ? Date.parse(j.finishedAt) : Number.NaN,
    ])
    if (intervals.flat().some(Number.isNaN)) return base
    return { ...base, wallSeconds: busySeconds(intervals) }
  })
}

/**
 * Stages in run order. Forges number jobs as a pipeline creates them, stage by stage, so within
 * one pipeline a stage whose first job has the lower id runs earlier. Each stage scores its wins
 * minus losses against every other stage across pipelines; ties fall back to the name.
 */
export function stageOrder(records: readonly CiJobRecord[]): string[] {
  const score = new Map<string, number>()
  for (const jobs of groupBy(records, (r) => String(r.pipelineId)).values()) {
    const first = new Map<string, number>()
    for (const job of jobs)
      first.set(job.stage, Math.min(first.get(job.stage) ?? Number.POSITIVE_INFINITY, job.jobId))
    const stages = [...first]
    for (const [stage, id] of stages) {
      const wins = stages.filter(([, other]) => id < other).length
      const losses = stages.filter(([, other]) => id > other).length
      score.set(stage, (score.get(stage) ?? 0) + wins - losses)
    }
  }
  return [...score]
    .toSorted(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([stage]) => stage)
}

const passed = (span: PipelineSpan) => !span.failed && !span.canceled

const passedSeconds = (spans: readonly PipelineSpan[]) =>
  defined(spans.filter(passed).map((s) => s.wallSeconds))

function pipelineStats(spans: readonly PipelineSpan[], to: string, ref?: string): PipelineStats {
  const weekAgo = addDays(to, -7)
  const twoWeeksAgo = addDays(to, -14)
  const recent = median(passedSeconds(spans.filter((s) => s.createdAt >= weekAgo)))
  const before = median(
    passedSeconds(spans.filter((s) => s.createdAt >= twoWeeksAgo && s.createdAt < weekAgo)),
  )
  const success = spans.filter(passed).length
  const failed = spans.filter((s) => s.failed).length
  const successRate = percent(success, spans.length)
  return {
    ...(ref ? { ref } : {}),
    count: spans.length,
    ...(successRate === undefined ? {} : { successRate }),
    outcomes: { success, failed, canceled: spans.length - success - failed },
    duration: spread(passedSeconds(spans)),
    queue: spread(defined(spans.flatMap((s) => s.jobs.map((j) => j.queuedSeconds)))),
    ...(recent !== undefined && before
      ? { change: round(((recent - before) / before) * 100) }
      : {}),
  }
}

/**
 * Pipeline time, success rate and queue of the default branch's pipelines (every pipeline when it
 * has none), plus durations, failure and retry rates and trends per job, from stored attempts
 * created in the window `[from, to]`, restricted to `options.branch` when set. Pure.
 */
export function analyzeCiJobs(
  records: readonly CiJobRecord[],
  window: { from: string; to: string; defaultBranch?: string },
  options: CiJobsOptions,
): CiJobsAnalysis {
  const from = new Date(window.from).toISOString()
  const to = new Date(window.to).toISOString()
  const runs = records.filter(
    (r) =>
      r.createdAt >= from && r.createdAt <= to && (!options.branch || r.ref === options.branch),
  )
  const latest = new Map<string, CiJobRecord>()
  for (const r of runs) {
    const current = latest.get(attemptKey(r))
    if (!current || r.jobId > current.jobId) latest.set(attemptKey(r), r)
  }
  const finals: ReadonlySet<CiJobRecord> = new Set(latest.values())
  const weeks = weeksOf(from, to)
  const stages = stageOrder(runs)
  const stageIndex = new Map(stages.map((stage, index) => [stage, index]))
  const jobs = [...groupBy(runs, (r) => r.name)]
    .map(([name, list]) =>
      jobStats(name, list, {
        finals,
        weeks,
        recentFrom: addDays(to, -options.recentDays),
        options,
      }),
    )
    .toSorted(
      (a, b) =>
        (stageIndex.get(a.stage) ?? 0) - (stageIndex.get(b.stage) ?? 0) ||
        a.name.localeCompare(b.name),
    )

  const spans = pipelineSpans(runs, finals)
  const ref =
    options.branch ??
    (window.defaultBranch && spans.some((s) => !s.tag && s.ref === window.defaultBranch)
      ? window.defaultBranch
      : undefined)
  const scoped = ref ? spans.filter((s) => s.ref === ref) : spans
  const byWeek = groupBy(scoped, (s) => weekOf(s.createdAt))
  const lastRunAt = runs
    .map((r) => r.createdAt)
    .toSorted()
    .at(-1)

  return {
    window: { from, to, days: options.days },
    options,
    ...(window.defaultBranch ? { defaultBranch: window.defaultBranch } : {}),
    ...(lastRunAt ? { lastRunAt } : {}),
    pipelines: pipelineStats(scoped, to, ref),
    weeks: weeks.map((week) => {
      const inWeek = byWeek.get(week) ?? []
      const { median: mid, p90 } = spread(passedSeconds(inWeek))
      return {
        week,
        pipelines: inWeek.length,
        ...(mid === undefined ? {} : { median: mid }),
        ...(p90 === undefined ? {} : { p90 }),
      }
    }),
    stages,
    jobs,
  }
}
