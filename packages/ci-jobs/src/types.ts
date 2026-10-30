import type { RefGroup } from './refs.ts'

/** Tunables of the CI jobs analysis. */
export interface CiJobsOptions {
  /** Length of the analyzed window, ending now. */
  days: number
  /** Only jobs of pipelines on this branch or tag; every ref when absent. */
  branch?: string
  /** Trailing days compared against the rest of the window to find slower and faster jobs. */
  recentDays: number
  /** Relative median change, in percent, that marks a job slower or faster. */
  changePercent: number
  /** Absolute median change, in seconds, below which a job counts as stable. */
  minChangeSeconds: number
}

/** Quantiles of durations in seconds over `samples` values. */
export interface Spread {
  samples: number
  p25?: number
  median?: number
  p75?: number
  p95?: number
  max?: number
}

/**
 * `slower`/`faster`: the recent median moved by at least `changePercent` and `minChangeSeconds`.
 * `new`: no successful run before the recent period. `idle`: no successful run in it.
 */
export type JobTrend = 'slower' | 'faster' | 'stable' | 'new' | 'idle'

/** When a job's duration shifted: the first day whose runs belong to the new level. */
export interface ChangePoint {
  at: string
  /** Median of successful runs before and after `at`, seconds. */
  before: number
  after: number
  /** First successful run at the new level. */
  sha?: string
  ref?: string
  href?: string
}

export interface JobWeek {
  week: string
  /** Attempts, retried ones included. */
  runs: number
  p25?: number
  median?: number
  p75?: number
  p95?: number
  /** Percent of final attempts that failed; absent without any. */
  failureRate?: number
}

export interface JobStats {
  name: string
  stage: string
  /** Attempts, retried ones included. */
  runs: number
  /** Pipelines the job ran in. */
  pipelines: number
  /** Final attempts that failed, jobs allowed to fail left out. */
  failures: number
  /** Percent of final attempts (allowed failures left out) that failed. */
  failureRate?: number
  /** Percent of pipelines where the job needed more than one attempt. */
  retryRate: number
  /** Pipelines where an attempt failed and a retry passed. */
  flaky: number
  allowFailure: boolean
  /** Successful attempts. */
  duration: Spread
  queueMedian?: number
  /** Run time of every attempt, seconds. */
  computeSeconds: number
  /** Percent of the window's total run time. */
  computeShare: number
  recentMedian?: number
  baselineMedian?: number
  /** Percent change of `recentMedian` over `baselineMedian`. */
  change?: number
  trend: JobTrend
  changePoint?: ChangePoint
  weeks: JobWeek[]
  last: { at: string; status: string; href: string; ref?: string }
}

export interface PipelineWeek {
  week: string
  pipelines: number
  runs: number
  failures: number
  /** Percent of final attempts that failed. */
  failureRate?: number
  /** Wall time of pipelines, first job start to last job end, seconds. */
  p25?: number
  median?: number
  p75?: number
  p95?: number
  queueMedian?: number
  computeSeconds: number
}

/** Pipelines of one kind of ref, e.g. every feature branch. */
export interface RefGroupStats {
  group: RefGroup
  label: string
  pipelines: number
  /** Distinct refs, e.g. how many feature branches ran. */
  refs: number
  /** Percent of pipelines with a failed job (jobs allowed to fail left out). */
  failureRate?: number
  /** Pipeline time of pipelines without failures, seconds. */
  duration: Spread
  recentMedian?: number
  baselineMedian?: number
  /** Percent change of `recentMedian` over `baselineMedian`. */
  change?: number
  weeks: { week: string; pipelines: number; median?: number; p95?: number }[]
  /** Busiest refs of the group with their median pipeline time, at most five. */
  topRefs: { ref: string; pipelines: number; median?: number }[]
}

/** Output of the `ci-jobs` analyzer: plain JSON, validated on ingest by `ciJobsDataSchema`. */
export interface CiJobsData {
  window: { from: string; to: string; days: number }
  options: CiJobsOptions
  /** The repository's default branch when the forge reported it. */
  defaultBranch?: string
  /** What the store holds for the repository after this run. */
  history: {
    oldest?: string
    newest?: string
    jobs: number
    /** Earliest time a full sync asked the forge for; later runs fetch only what is new. */
    syncedFrom?: string
  }
  sync: {
    mode: 'full' | 'incremental' | 'none'
    after?: string
    fetched: number
    stored: number
  }
  notes: string[]
  totals: {
    runs: number
    pipelines: number
    jobs: number
    failures: number
    failureRate?: number
    retryRate: number
    flakyJobs: number
    slowerJobs: number
    fasterJobs: number
    computeSeconds: number
    /** Pipeline wall time, seconds. */
    wallTime: Spread
    queue: Spread
  }
  weeks: PipelineWeek[]
  /** Pipeline time by kind of ref, in `refGroups` order; groups without pipelines left out. */
  refGroups: RefGroupStats[]
  /** Compute seconds per stage, largest first. */
  stages: { stage: string; computeSeconds: number }[]
  /** Every job of the window, by compute time descending. */
  jobs: JobStats[]
}
