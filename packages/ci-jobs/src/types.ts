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

/** Median and p90 of durations in seconds over `samples` values. */
export interface Spread {
  samples: number
  median?: number
  p90?: number
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
  href?: string
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
  recentMedian?: number
  baselineMedian?: number
  /** Percent change of `recentMedian` over `baselineMedian`. */
  change?: number
  trend: JobTrend
  changePoint?: ChangePoint
  /** Median of successful attempts per week of `CiJobsData.weeks`; `null` for weeks without one. */
  weeks: (number | null)[]
  last: { at: string; status: string; href: string }
}

/** Pipelines the headline numbers describe. */
export interface PipelineStats {
  /** The branch they ran on: the default branch when it has pipelines; every ref when absent. */
  ref?: string
  count: number
  /** Percent of pipelines where every final attempt of a job not allowed to fail passed. */
  successRate?: number
  /** Pipeline time of passing pipelines: seconds any of their jobs ran, gaps left out. */
  duration: Spread
  /** Queue time of their job attempts. */
  queue: Spread
  /** Percent change of the median pipeline time over the last 7 days against the 7 days before. */
  change?: number
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
  /** Newest job attempt of the window. */
  lastRunAt?: string
  pipelines: PipelineStats
  /** Pipeline time of passing `pipelines` per week (Monday, UTC), oldest first. */
  weeks: { week: string; pipelines: number; median?: number; p90?: number }[]
  /** Stages in the order pipelines run them. */
  stages: string[]
  /** Every job of the window, in stage order, then by name. */
  jobs: JobStats[]
}

/** Why a job made the problem list: it got slower, passes only on retry or keeps failing. */
export type CiProblemKind = 'slower' | 'flaky' | 'failing'

/** One row of the short problem list: a job, its problem and a one-line reason. */
export interface CiProblem {
  job: string
  stage: string
  kind: CiProblemKind
  reason: string
  /** Where to look: the run where a slowdown started, otherwise the job's last run. */
  href: string
}
