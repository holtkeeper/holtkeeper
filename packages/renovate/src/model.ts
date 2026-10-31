import { z } from 'zod'

import { renovateModeSchema } from './options.ts'

/** Renovate's update types; `lockFileMaintenance` refreshes a whole lockfile. */
export const renovateUpdateTypeSchema = z.enum([
  'major',
  'minor',
  'patch',
  'pin',
  'digest',
  'pinDigest',
  'lockFileMaintenance',
  'rollback',
  'bump',
  'replacement',
])

/** One update Renovate found for a declared dependency. */
export const renovateUpdateSchema = z.object({
  dependency: z.string(),
  manager: z.string(),
  /** Repository-relative file that declares it. */
  file: z.string(),
  depType: z.string().optional(),
  current: z.string().optional(),
  next: z.string().optional(),
  type: renovateUpdateTypeSchema,
  /** The update fixes a known vulnerability. */
  vulnerability: z.boolean(),
  /** Held back until the release is old enough (`releaseAgeDays`). */
  pending: z.boolean(),
  /** When the new version was released (ISO 8601), when the registry says. */
  releasedAt: z.string().optional(),
  /** Source repository or homepage of the dependency. */
  url: z.string().optional(),
  /** Number of the merge request that carries it, when Renovate opened one. */
  mergeRequest: z.number().optional(),
})

/** A dependency whose registry marks it deprecated, or that has not been released for long. */
export const renovateDeprecationSchema = z.object({
  dependency: z.string(),
  manager: z.string(),
  file: z.string(),
  message: z.string().optional(),
  abandoned: z.boolean(),
})

/** Pipeline states of `@holtkeeper/forge`. */
export const pipelineStatusSchema = z.enum([
  'pending',
  'running',
  'success',
  'failed',
  'canceled',
  'skipped',
  'manual',
])

/** A Renovate merge request as the forge saw it during the run. */
export const renovateMergeRequestSchema = z.object({
  id: z.number(),
  url: z.string().optional(),
  title: z.string(),
  branch: z.string(),
  state: z.enum(['open', 'merged', 'closed']),
  draft: z.boolean(),
  /** Pipeline of the merge request's head, when it has one. */
  pipeline: pipelineStatusSchema.optional(),
  /** Renovate's branch result, e.g. `done`, `pr-created`, `pr-limit-reached`, `error`. */
  result: z.string().optional(),
  types: z.array(renovateUpdateTypeSchema),
  updates: z.number(),
  mergedAt: z.string().optional(),
})

/** A warning or error Renovate logged for the repository. */
export const renovateProblemSchema = z.object({
  level: z.enum(['warning', 'error', 'fatal']),
  message: z.string(),
})

/** Files and dependencies one Renovate manager (npm, gomod, dockerfile, ...) found. */
export const renovateManagerSchema = z.object({
  manager: z.string(),
  files: z.number(),
  dependencies: z.number(),
})

/**
 * What one Renovate run found in a repository.
 * - `status`: `failed` when Renovate wrote no report or logged a fatal problem; `output` says why.
 * - `mode`: what the run did; `report` also when `merge-requests` was asked for a read-only repository.
 */
export const renovateDataSchema = z.object({
  status: z.enum(['ok', 'failed']),
  mode: renovateModeSchema,
  readOnly: z.boolean(),
  renovateVersion: z.string(),
  startedAt: z.string(),
  durationMs: z.number(),
  /** Declared dependencies Renovate looked up, and how many of them have an update. */
  dependencies: z.number(),
  outdated: z.number(),
  /** Sum of years each dependency lags behind its newest release, when Renovate computed it. */
  libYears: z.number().optional(),
  managers: z.array(renovateManagerSchema),
  updates: z.array(renovateUpdateSchema),
  deprecated: z.array(renovateDeprecationSchema),
  /** Open Renovate merge requests, and those merged or closed in the last 30 days. */
  mergeRequests: z.array(renovateMergeRequestSchema),
  problems: z.array(renovateProblemSchema),
  /** The last lines of Renovate's log. */
  output: z.string(),
})

export type RenovateUpdateType = z.output<typeof renovateUpdateTypeSchema>
export type RenovateUpdate = z.output<typeof renovateUpdateSchema>
export type RenovateDeprecation = z.output<typeof renovateDeprecationSchema>
export type RenovateMergeRequest = z.output<typeof renovateMergeRequestSchema>
export type RenovateProblem = z.output<typeof renovateProblemSchema>
export type RenovateData = z.output<typeof renovateDataSchema>

/** Whether a merge request needs a person: open with a failed pipeline or a Renovate error. */
export const isBroken = (mergeRequest: RenovateMergeRequest) =>
  mergeRequest.state === 'open' &&
  (mergeRequest.pipeline === 'failed' || mergeRequest.result === 'error')

/** Whether a merge request waits for review: open, not a draft and not broken. */
export const awaitsReview = (mergeRequest: RenovateMergeRequest) =>
  mergeRequest.state === 'open' && !mergeRequest.draft && !isBroken(mergeRequest)
