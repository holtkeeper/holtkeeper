import type { RepoRef } from '@holtkeeper/forge'
import { defineAnalysis, metric } from '@holtkeeper/report'
import type { Cell, Metric, Report, Section, Tone } from '@holtkeeper/report'

import { jobProblems, problemJobs } from './problems.ts'
import { ciJobsDataSchema, readCiJobs } from './schema.ts'
import { formatDuration } from './stats.ts'
import type { CiJobsData, CiOutcomes, CiProblemKind, JobTrend } from './types.ts'

const ms = (seconds: number | undefined) =>
  seconds === undefined ? undefined : Math.round(seconds * 1000)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const weekLabel = (week: string) => {
  const date = new Date(`${week}T00:00:00Z`)
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`
}

const signed = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : '±'}${Math.abs(value)}%`

const failureTone = (rate: number | undefined): Tone =>
  rate === undefined ? 'neutral' : rate < 5 ? 'good' : rate < 15 ? 'warning' : 'bad'

const TREND_TONE: Record<JobTrend, Tone> = {
  slower: 'bad',
  faster: 'good',
  stable: 'neutral',
  new: 'info',
  idle: 'neutral',
}

const PROBLEM_TONE: Record<CiProblemKind, Tone> = {
  failing: 'bad',
  slower: 'warning',
  flaky: 'warning',
}

function measured(
  id: string,
  label: string,
  value: number | undefined,
  options: {
    unit?: Metric['unit']
    previous?: number | undefined
    better: 'up' | 'down'
    hint?: string
  },
): Metric {
  if (value === undefined) return { id, label, value: 'n/a', unit: 'text' }
  const { previous, ...rest } = options
  return metric(id, label, value, { ...rest, ...(previous === undefined ? {} : { previous }) })
}

const scope = (data: CiJobsData) =>
  data.pipelines.ref ? `${data.pipelines.ref} pipelines` : 'pipelines of every branch'

/** The three headline numbers of the CI page, with deltas against `previous` when given. */
function headline(data: CiJobsData, previous?: CiJobsData): Metric[] {
  const { pipelines } = data
  return [
    measured('pipeline-time', 'Pipeline time (median)', ms(pipelines.duration.median), {
      unit: 'ms',
      previous: ms(previous?.pipelines.duration.median),
      better: 'down',
      hint: `Passing ${scope(data)}, while any job ran. p90 ${formatDuration(pipelines.duration.p90 ?? 0)}.`,
    }),
    measured('success-rate', 'Success rate', pipelines.successRate, {
      unit: 'percent',
      previous: previous?.pipelines.successRate,
      better: 'up',
      hint: `${pipelines.count} ${scope(data)}; canceled ones count as not passed, jobs allowed to fail are left out.`,
    }),
    measured('queue', 'Queue (median)', ms(pipelines.queue.median), {
      unit: 'ms',
      previous: ms(previous?.pipelines.queue.median),
      better: 'down',
      hint: 'Waiting for a runner.',
    }),
  ]
}

function problemsSection(data: CiJobsData): Section {
  const problems = problemJobs(data)
  return {
    id: 'problems',
    title: 'Problem jobs',
    blocks: problems.length
      ? [
          {
            type: 'issues',
            items: problems.map((problem) => ({
              id: `${problem.kind}:${problem.job}`,
              tone: PROBLEM_TONE[problem.kind],
              title: `${problem.job}: ${problem.reason}`,
              href: problem.href,
              tags: [problem.kind, problem.stage],
            })),
          },
        ]
      : [{ type: 'markdown', text: 'No job got slower, keeps failing or passes only on retry.' }],
  }
}

function pipelineTimeSection(data: CiJobsData): Section {
  return {
    id: 'pipeline-time',
    title: 'Pipeline time per week',
    description: `Passing ${scope(data)} in the last ${data.window.days} days.`,
    blocks: [
      {
        type: 'chart',
        chart: 'line',
        unit: 'ms',
        x: 'week',
        series: [
          { key: 'median', label: 'Median', tone: 'info' },
          { key: 'p90', label: 'p90', tone: 'warning', dashed: true },
        ],
        data: data.weeks.map((w) => ({
          week: weekLabel(w.week),
          median: ms(w.median) ?? null,
          p90: ms(w.p90) ?? null,
        })),
      },
    ],
  }
}

function jobsSection(data: CiJobsData): Section {
  const rows = data.jobs.map((job): Record<string, Cell> => ({
    job: {
      text: job.name,
      href: job.last.href,
      ...(job.allowFailure ? { hint: 'Allowed to fail' } : {}),
    },
    stage: job.stage,
    runs: job.runs,
    median: {
      text: formatDuration(job.duration.median ?? 0),
      value: ms(job.duration.median) ?? 0,
      series: job.weeks.map((w) => ms(w ?? undefined) ?? null),
      tone: TREND_TONE[job.trend],
    },
    p90: ms(job.duration.p90) ?? null,
    change:
      job.change === undefined
        ? null
        : { text: signed(job.change), value: job.change, tone: TREND_TONE[job.trend] },
    failureRate:
      job.failureRate === undefined
        ? null
        : {
            text: `${job.failureRate}%`,
            value: job.failureRate,
            tone: failureTone(job.failureRate),
          },
  }))
  return {
    id: 'jobs',
    title: 'Jobs',
    description: 'Every job in stage order, with its weekly median duration.',
    blocks: [
      {
        type: 'table',
        columns: [
          { key: 'job', label: 'Job', format: 'code' },
          { key: 'stage', label: 'Stage' },
          { key: 'runs', label: 'Runs', align: 'end' },
          { key: 'median', label: 'Median', unit: 'ms', format: 'sparkline' },
          { key: 'p90', label: 'p90', unit: 'ms', align: 'end' },
          { key: 'change', label: 'Recent change', align: 'end' },
          { key: 'failureRate', label: 'Failure rate', unit: 'percent', align: 'end' },
        ],
        rows,
      },
    ],
  }
}

function reliabilitySection(data: CiJobsData): Section {
  const unreliable = data.jobs
    .filter((j) => j.failures > 0 || j.flaky > 0)
    .toSorted(
      (a, b) =>
        (b.failureRate ?? 0) - (a.failureRate ?? 0) ||
        b.flaky - a.flaky ||
        a.name.localeCompare(b.name),
    )
  return {
    id: 'reliability',
    title: 'Reliability',
    description: 'Jobs that failed or passed only on retry, worst failure rate first.',
    blocks: unreliable.length
      ? [
          {
            type: 'table',
            columns: [
              { key: 'job', label: 'Job', format: 'code' },
              { key: 'failureRate', label: 'Failure rate', unit: 'percent', align: 'end' },
              { key: 'failures', label: 'Failures', align: 'end' },
              { key: 'flaky', label: 'Flaky pipelines', align: 'end' },
              { key: 'retryRate', label: 'Retried', unit: 'percent', align: 'end' },
            ],
            rows: unreliable.map((job) => ({
              job: { text: job.name, href: job.last.href },
              failureRate: {
                text: `${job.failureRate ?? 0}%`,
                value: job.failureRate ?? 0,
                tone: failureTone(job.failureRate),
              },
              failures: job.failures,
              flaky: job.flaky,
              retryRate: job.retryRate,
            })),
          },
        ]
      : [{ type: 'markdown', text: 'No job failed or needed a retry to pass in the window.' }],
  }
}

/** The CI jobs report: headline numbers, problem jobs, weekly pipeline time, jobs, reliability. */
export function ciJobsReport(
  data: CiJobsData,
  options: { previous?: CiJobsData; repo?: RepoRef; ref?: string; generatedAt?: string } = {},
): Report {
  return {
    kind: 'ci-jobs',
    title: 'CI jobs',
    subtitle: `Last ${data.window.days} days${data.options.branch ? ` on ${data.options.branch}` : ''}`,
    subject: {
      ...(options.repo ? { repo: options.repo } : {}),
      ...(options.ref ? { ref: options.ref } : {}),
    },
    generatedAt: options.generatedAt ?? data.window.to,
    metrics: headline(data, options.previous),
    sections: [
      problemsSection(data),
      pipelineTimeSection(data),
      jobsSection(data),
      reliabilitySection(data),
    ],
  }
}

/**
 * State of a repository's CI, worst first: a job keeps failing, passes only on retry or got
 * slower; `healthy` without such jobs; `idle` when no pipeline ran in the window.
 */
export type CiStatus = 'failing' | 'flaky' | 'slower' | 'healthy' | 'idle'

/** Stored headline numbers of one `ci-jobs` record. Durations are seconds. */
export interface CiJobsMetrics {
  status: CiStatus
  /** Branch the pipeline numbers describe; absent when they cover every ref. */
  ref?: string
  pipelines: number
  /** Percent of pipelines that passed. */
  successRate?: number
  /** Pipelines by outcome; absent for records written before it was counted. */
  outcomes?: CiOutcomes
  /** Pipeline time of passing pipelines. */
  median?: number
  p90?: number
  /** Percent change of the median pipeline time, last 7 days against the 7 before. */
  change?: number
  /** Median queue time of job attempts. */
  queue?: number
  /** Jobs per problem, as the problem list judges them; one job may count in several. */
  failing: number
  flaky: number
  slower: number
  /** Jobs on the problem list (`problemJobs`), at most five; absent for records written before. */
  problems?: number
  /**
   * Median pipeline time per week of the window, oldest first, `null` for weeks without a passing
   * pipeline; absent for records written before.
   */
  weeks?: (number | null)[]
  lastRunAt?: string
}

/** `CiJobsMetrics` of `data`. */
export function ciJobsMetrics(data: CiJobsData): CiJobsMetrics {
  const problems = data.jobs.map(jobProblems)
  const jobs = (kind: CiProblemKind) => problems.filter((list) => list.includes(kind)).length
  const failing = jobs('failing')
  const flaky = jobs('flaky')
  const slower = jobs('slower')
  const { pipelines } = data
  return {
    status:
      pipelines.count === 0
        ? 'idle'
        : failing
          ? 'failing'
          : flaky
            ? 'flaky'
            : slower
              ? 'slower'
              : 'healthy',
    ...(pipelines.ref ? { ref: pipelines.ref } : {}),
    pipelines: pipelines.count,
    ...(pipelines.successRate === undefined ? {} : { successRate: pipelines.successRate }),
    ...(pipelines.outcomes ? { outcomes: pipelines.outcomes } : {}),
    ...(pipelines.duration.median === undefined ? {} : { median: pipelines.duration.median }),
    ...(pipelines.duration.p90 === undefined ? {} : { p90: pipelines.duration.p90 }),
    ...(pipelines.change === undefined ? {} : { change: pipelines.change }),
    ...(pipelines.queue.median === undefined ? {} : { queue: pipelines.queue.median }),
    failing,
    flaky,
    slower,
    problems: problemJobs(data).length,
    weeks: data.weeks.map((week) => week.median ?? null),
    ...(data.lastRunAt ? { lastRunAt: data.lastRunAt } : {}),
  }
}

/** The `ci-jobs` analysis kind: pipeline time, success rate and problem jobs of a repository. */
export const ciJobsAnalysis = defineAnalysis<CiJobsData, CiJobsMetrics>({
  kind: 'ci-jobs',
  label: 'CI jobs',
  schema: ciJobsDataSchema,
  metrics: ciJobsMetrics,
  summarize: (data) => {
    const read = readCiJobs(data)
    return read ? headline(read) : []
  },
  toReport: (current, previous) => {
    const data = readCiJobs(current.data)
    const subject = { repo: current.repo, ...(current.ref ? { ref: current.ref } : {}) }
    if (!data)
      return {
        kind: 'ci-jobs',
        title: 'CI jobs',
        subject,
        generatedAt: current.createdAt,
        metrics: [],
        sections: [
          {
            id: 'outdated',
            title: 'Older format',
            blocks: [
              {
                type: 'markdown',
                text: 'This record was written by an earlier version. The next nightly run replaces it.',
              },
            ],
          },
        ],
      }
    const before = previous ? readCiJobs(previous.data) : undefined
    return ciJobsReport(data, {
      ...(before ? { previous: before } : {}),
      ...subject,
      generatedAt: current.createdAt,
    })
  },
})
