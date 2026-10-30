import type {
  Deployment,
  JobRun,
  MergeRequestRecord,
  PipelineRun,
  TagRecord,
} from '@holtkeeper/forge'

/** Tunables of the delivery analysis. */
export interface DeliveryOptions {
  /** Length of the analyzed window, ending now. */
  days: number
  /** Environment whose deployments count as production releases. */
  productionEnvironment: string
  /** How long after a deployment a failure signal is blamed on it. */
  failureWindowHours: number
  /** Open merge requests without an update for this many days are stale. */
  staleDays: number
}

/** Everything the computations read, as fetched from a forge. Times are ISO 8601. */
export interface DeliveryInput {
  /** Window start and end. */
  from: string
  to: string
  defaultBranch: string
  /** Merge requests updated in the window plus every open one. */
  mergeRequests: MergeRequestRecord[]
  /** Deployments to the production environment. */
  deployments: Deployment[]
  tags: TagRecord[]
  pipelines: PipelineRun[]
  /** Job attempts of the pipelines whose jobs were loaded. */
  jobs: JobRun[]
  /** Pipelines whose jobs were loaded. */
  jobPipelines: number
  /** What could not be fetched and why, for the report's notes. */
  notes: string[]
}

/** Where deployment events come from: real deployments, or the fallbacks when there are none. */
export type DeploySource = 'deployments' | 'tags' | 'pipelines' | 'none'

/** DORA performance band. */
export type Band = 'elite' | 'high' | 'medium' | 'low'

/** Median and 90th or 95th percentile of a duration in seconds, over `samples` values. */
export interface Distribution {
  samples: number
  median?: number
  p90?: number
  p95?: number
}

export type FailureKind = 'deployment' | 'revert' | 'hotfix'

/** Something that shows a change failed in production. */
export interface FailureSignal {
  kind: FailureKind
  /** When the failure became visible: the failed deployment, or the fixing merge request's creation. */
  at: string
  /** Restoration is the first successful deployment after this time. */
  fixedAfter: string
  title: string
  href?: string
  /** Deployment the failure was blamed on, when one happened within the failure window before it. */
  blamedOn?: string
  /** Seconds until the next successful deployment; absent while unresolved. */
  restoreSeconds?: number
}

export interface DoraWeek {
  week: string
  deployments: number
  failedChanges: number
  /** Median lead time of changes deployed that week, seconds. */
  leadTimeMedian?: number
}

export interface DoraData {
  source: DeploySource
  deployments: number
  failedDeployments: number
  deploymentsPerWeek: number
  /** Merge request created (or first commit) → deployed, seconds. */
  leadTime: Distribution
  /** Merge request created → merged, seconds. */
  timeToMerge: Distribution
  /** Merged → deployed, seconds. */
  timeToDeploy: Distribution
  /** Merged into the default branch in the window, but no deployment after the merge yet. */
  undeployed: number
  /** Successful deployments followed by a failure signal within the window. */
  failedChanges: number
  /** Percent of successful deployments that are failed changes; absent without deployments. */
  changeFailureRate?: number
  /** Failure → next successful deployment, seconds; overlapping failures count once. */
  timeToRestore: Distribution & { incidents: number; unresolved: number }
  bands: {
    deploymentFrequency: Band
    leadTime?: Band
    changeFailureRate?: Band
    timeToRestore?: Band
  }
  weeks: DoraWeek[]
  failures: FailureSignal[]
}

export interface PipelineWeek {
  week: string
  pipelines: number
  successRate?: number
  durationMedian?: number
  durationP95?: number
  queueMedian?: number
}

export interface JobTiming {
  name: string
  stage: string
  runs: number
  median: number
  p95: number
}

export interface FlakyJob {
  name: string
  stage: string
  /** Pipelines where an attempt failed and a retry passed. */
  retriedThenPassed: number
  /** Commits whose pipelines both passed and failed this job. */
  alternatingShas: number
  occurrences: number
}

export interface FailingJob {
  name: string
  stage: string
  failures: number
  runs: number
  /** Percent of final attempts that failed. */
  failureRate: number
}

export interface CiData {
  pipelines: number
  /** Pipelines that succeeded, failed or were canceled. */
  finished: number
  /** Percent of succeeded among succeeded and failed pipelines. */
  successRate?: number
  duration: Distribution
  queue: Distribution
  weeks: PipelineWeek[]
  /** Pipelines whose jobs were analyzed. */
  jobPipelines: number
  slowestJobs: JobTiming[]
  flakyJobs: FlakyJob[]
  failingJobs: FailingJob[]
}

export interface StaleMergeRequest {
  id: number
  title: string
  author: string
  webUrl: string
  draft: boolean
  labels: string[]
  createdAt: string
  updatedAt: string
  ageDays: number
  idleDays: number
}

export interface MergeRequestFlow {
  open: number
  drafts: number
  /** Open merge requests by age since creation. */
  openByAge: { label: string; count: number }[]
  stale: StaleMergeRequest[]
  /** Merged in the window, any target branch. */
  merged: number
  timeToMerge: Distribution & { buckets: { label: string; count: number }[] }
  /** Changed files per merged merge request, when the forge reports it. */
  size?: Distribution
}

/** Output of the `delivery` analyzer: plain JSON, validated on ingest by `deliveryDataSchema`. */
export interface DeliveryData {
  window: { from: string; to: string; days: number }
  options: DeliveryOptions
  defaultBranch: string
  counts: {
    mergeRequests: number
    deployments: number
    tags: number
    pipelines: number
    jobs: number
  }
  notes: string[]
  dora: DoraData
  ci: CiData
  mergeRequests: MergeRequestFlow
}
