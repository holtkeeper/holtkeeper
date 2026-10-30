import type { CiJobRecord } from '@holtkeeper/store'

import { refGroupOf, refGroups } from './refs.ts'
import { addDays, groupBy, median, percent, round, spread, weekOf, weeksOf } from './stats.ts'
import type {
  ChangePoint,
  CiJobsData,
  CiJobsOptions,
  JobStats,
  JobTrend,
  JobWeek,
  PipelineWeek,
  RefGroupStats,
  Spread,
} from './types.ts'

/** Successful runs each side needs before a job can count as slower or faster. */
const MIN_SAMPLES = 5
/** Days with successful runs each side of a change point needs. */
const MIN_DAYS = 3

/** The parts of `CiJobsData` computed from stored job attempts alone. */
export type CiJobsAnalysis = Pick<
  CiJobsData,
  'window' | 'options' | 'defaultBranch' | 'totals' | 'weeks' | 'refGroups' | 'stages' | 'jobs'
>

/** The p25 to p95 fields of a spread that are set. */
function quantiles({ p25, median: mid, p75, p95 }: Spread) {
  return {
    ...(p25 === undefined ? {} : { p25 }),
    ...(mid === undefined ? {} : { median: mid }),
    ...(p75 === undefined ? {} : { p75 }),
    ...(p95 === undefined ? {} : { p95 }),
  }
}

const attemptKey = (r: CiJobRecord) => `${r.pipelineId}\u0000${r.name}`
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)
const mean = (values: readonly number[]) => (values.length ? sum(values) / values.length : 0)
const defined = (values: readonly (number | undefined)[]) =>
  values.filter((value) => value !== undefined)
const succeeded = (r: CiJobRecord) => r.status === 'success' && r.durationSeconds !== undefined
const byTime = (a: CiJobRecord, b: CiJobRecord) =>
  a.createdAt.localeCompare(b.createdAt) || a.jobId - b.jobId

/** Final attempts that count towards failure rates: not allowed to fail, not canceled. */
const counted = (finals: readonly CiJobRecord[]) =>
  finals.filter((r) => !r.allowFailure && r.status !== 'canceled')

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
    ...(first.ref ? { ref: first.ref } : {}),
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

function jobWeek(
  week: string,
  runs: readonly CiJobRecord[],
  finals: ReadonlySet<CiJobRecord>,
): JobWeek {
  const considered = counted(runs.filter((r) => finals.has(r)))
  const failureRate = percent(
    considered.filter((r) => r.status === 'failed').length,
    considered.length,
  )
  return {
    week,
    runs: runs.length,
    ...quantiles(spread(defined(runs.filter(succeeded).map((r) => r.durationSeconds)))),
    ...(failureRate === undefined ? {} : { failureRate }),
  }
}

function jobStats(
  name: string,
  runs: CiJobRecord[],
  context: {
    finals: ReadonlySet<CiJobRecord>
    weeks: readonly string[]
    recentFrom: string
    totalCompute: number
    options: CiJobsOptions
  },
): JobStats {
  const ordered = runs.toSorted(byTime)
  const last = ordered.at(-1) ?? ordered[0]
  if (!last) throw new Error(`job ${name} has no runs`)
  const byPipeline = groupBy(ordered, (r) => String(r.pipelineId))
  const considered = counted(ordered.filter((r) => context.finals.has(r)))
  const failures = considered.filter((r) => r.status === 'failed').length
  const failureRate = percent(failures, considered.length)
  const successes = ordered.filter(succeeded)
  const seconds = (list: readonly CiJobRecord[]) => defined(list.map((r) => r.durationSeconds))
  const recent = successes.filter((r) => r.createdAt >= context.recentFrom)
  const baseline = successes.filter((r) => r.createdAt < context.recentFrom)
  const trend = trendOf(seconds(recent), seconds(baseline), context.options)
  const point =
    trend.trend === 'slower' || trend.trend === 'faster'
      ? changePoint(successes, trend.trend === 'slower' ? 1 : -1)
      : undefined
  const computeSeconds = round(sum(seconds(ordered)))
  const queueMedian = median(defined(ordered.map((r) => r.queuedSeconds)))
  const byWeek = groupBy(ordered, (r) => weekOf(r.createdAt))
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
    allowFailure: last.allowFailure,
    duration: spread(seconds(successes)),
    ...(queueMedian === undefined ? {} : { queueMedian: round(queueMedian) }),
    computeSeconds,
    computeShare: percent(computeSeconds, context.totalCompute) ?? 0,
    ...trend,
    ...(point ? { changePoint: point } : {}),
    weeks: context.weeks.map((week) => jobWeek(week, byWeek.get(week) ?? [], context.finals)),
    last: {
      at: last.createdAt,
      status: last.status,
      href: last.webUrl,
      ...(last.ref ? { ref: last.ref } : {}),
    },
  }
}

interface PipelineSpan {
  createdAt: string
  ref?: string
  tag: boolean
  /** A final attempt of a job not allowed to fail failed. */
  failed: boolean
  /** Seconds at least one job ran, gaps left out; absent when a job lacks times. */
  wallSeconds?: number
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
    const base = {
      createdAt,
      ...(ref ? { ref } : {}),
      tag: jobs.some((j) => j.tag),
      failed: counted(jobs.filter((j) => finals.has(j))).some((j) => j.status === 'failed'),
    }
    const intervals = jobs.map((j): [number, number] => [
      j.startedAt ? Date.parse(j.startedAt) : Number.NaN,
      j.finishedAt ? Date.parse(j.finishedAt) : Number.NaN,
    ])
    if (intervals.flat().some(Number.isNaN)) return base
    return { ...base, wallSeconds: busySeconds(intervals) }
  })
}

const TOP_REFS = 5

/** Pipeline time per kind of ref; durations come from pipelines without failures. */
function refGroupStats(
  spans: readonly PipelineSpan[],
  context: { weeks: readonly string[]; recentFrom: string; defaultBranch?: string },
): RefGroupStats[] {
  const groupOf = (span: PipelineSpan) =>
    refGroupOf(span.ref, {
      tag: span.tag,
      ...(context.defaultBranch ? { defaultBranch: context.defaultBranch } : {}),
    })
  const byGroup = groupBy(spans, groupOf)
  const defaultGroup = context.defaultBranch
    ? refGroupOf(context.defaultBranch, { defaultBranch: context.defaultBranch })
    : undefined
  const passedSeconds = (list: readonly PipelineSpan[]) =>
    defined(list.filter((s) => !s.failed).map((s) => s.wallSeconds))
  return refGroups.flatMap(({ group, label }) => {
    const list = byGroup.get(group) ?? []
    if (!list.length) return []
    const recentMedian = median(
      passedSeconds(list.filter((s) => s.createdAt >= context.recentFrom)),
    )
    const baselineMedian = median(
      passedSeconds(list.filter((s) => s.createdAt < context.recentFrom)),
    )
    const failureRate = percent(list.filter((s) => s.failed).length, list.length)
    const byWeek = groupBy(list, (s) => weekOf(s.createdAt))
    const byRef = groupBy(list, (s) => s.ref ?? '')
    return [
      {
        group,
        hasDefault: defaultGroup === group,
        label:
          defaultGroup === group && context.defaultBranch
            ? `${label} (default: ${context.defaultBranch})`
            : label,
        pipelines: list.length,
        refs: byRef.size,
        ...(failureRate === undefined ? {} : { failureRate }),
        duration: spread(passedSeconds(list)),
        ...(recentMedian === undefined ? {} : { recentMedian: round(recentMedian) }),
        ...(baselineMedian === undefined ? {} : { baselineMedian: round(baselineMedian) }),
        ...(recentMedian !== undefined && baselineMedian
          ? { change: round(((recentMedian - baselineMedian) / baselineMedian) * 100) }
          : {}),
        weeks: context.weeks.map((week) => {
          const inWeek = byWeek.get(week) ?? []
          const { median: mid, p95 } = spread(passedSeconds(inWeek))
          return {
            week,
            pipelines: inWeek.length,
            ...(mid === undefined ? {} : { median: mid }),
            ...(p95 === undefined ? {} : { p95 }),
          }
        }),
        topRefs: [...byRef]
          .toSorted(([a, x], [b, y]) => y.length - x.length || a.localeCompare(b))
          .slice(0, TOP_REFS)
          .map(([ref, runs]) => {
            const mid = median(passedSeconds(runs))
            return {
              ref: ref || '(unknown)',
              pipelines: runs.length,
              ...(mid === undefined ? {} : { median: round(mid) }),
            }
          }),
      },
    ]
  })
}

function pipelineWeek(
  week: string,
  runs: readonly CiJobRecord[],
  spans: readonly PipelineSpan[],
  finals: ReadonlySet<CiJobRecord>,
): PipelineWeek {
  const considered = counted(runs.filter((r) => finals.has(r)))
  const failures = considered.filter((r) => r.status === 'failed').length
  const failureRate = percent(failures, considered.length)
  const queue = median(defined(runs.map((r) => r.queuedSeconds)))
  return {
    week,
    pipelines: spans.length,
    runs: runs.length,
    failures,
    ...(failureRate === undefined ? {} : { failureRate }),
    ...quantiles(spread(defined(spans.map((s) => s.wallSeconds)))),
    ...(queue === undefined ? {} : { queueMedian: round(queue) }),
    computeSeconds: round(sum(defined(runs.map((r) => r.durationSeconds)))),
  }
}

/**
 * Durations, failure and retry rates per job and per week from stored attempts created in the
 * window `[from, to]`, restricted to `options.branch` when set. Pure.
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
  const totalCompute = sum(defined(runs.map((r) => r.durationSeconds)))
  const jobs = [...groupBy(runs, (r) => r.name)]
    .map(([name, list]) =>
      jobStats(name, list, {
        finals,
        weeks,
        recentFrom: addDays(to, -options.recentDays),
        totalCompute,
        options,
      }),
    )
    .toSorted((a, b) => b.computeSeconds - a.computeSeconds || a.name.localeCompare(b.name))

  const spans = pipelineSpans(runs, finals)
  const spansByWeek = groupBy(spans, (s) => weekOf(s.createdAt))
  const runsByWeek = groupBy(runs, (r) => weekOf(r.createdAt))
  const considered = counted([...finals])
  const failures = considered.filter((r) => r.status === 'failed').length
  const failureRate = percent(failures, considered.length)
  const pairs = groupBy(runs, attemptKey)
  const stages = [...groupBy(runs, (r) => r.stage)]
    .map(([stage, list]) => ({
      stage,
      computeSeconds: round(sum(defined(list.map((r) => r.durationSeconds)))),
    }))
    .toSorted((a, b) => b.computeSeconds - a.computeSeconds || a.stage.localeCompare(b.stage))

  return {
    window: { from, to, days: options.days },
    options,
    ...(window.defaultBranch ? { defaultBranch: window.defaultBranch } : {}),
    totals: {
      runs: runs.length,
      pipelines: spans.length,
      jobs: jobs.length,
      failures,
      ...(failureRate === undefined ? {} : { failureRate }),
      retryRate: percent([...pairs.values()].filter((a) => a.length > 1).length, pairs.size) ?? 0,
      flakyJobs: jobs.filter((j) => j.flaky > 0).length,
      slowerJobs: jobs.filter((j) => j.trend === 'slower').length,
      fasterJobs: jobs.filter((j) => j.trend === 'faster').length,
      computeSeconds: round(totalCompute),
      wallTime: spread(defined(spans.map((s) => s.wallSeconds))),
      queue: spread(defined(runs.map((r) => r.queuedSeconds))),
    },
    weeks: weeks.map((week) =>
      pipelineWeek(week, runsByWeek.get(week) ?? [], spansByWeek.get(week) ?? [], finals),
    ),
    refGroups: refGroupStats(spans, {
      weeks,
      recentFrom: addDays(to, -options.recentDays),
      ...(window.defaultBranch ? { defaultBranch: window.defaultBranch } : {}),
    }),
    stages,
    jobs,
  }
}
