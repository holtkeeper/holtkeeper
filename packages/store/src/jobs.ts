import type { Timestamp } from './types.ts'

/** The latest `runAfter` a claim at `now` may take under `ClaimRules.delayMs`. */
export const claimDueBy = (now: Timestamp, delayMs = 0): Timestamp =>
  delayMs > 0 ? new Date(Date.parse(now) - delayMs).toISOString() : now

/** Lines `JobStore.appendLog` keeps per job. */
export const JOB_LOG_LIMIT = 200

/** Attempts a job gets when `NewJob.maxAttempts` is omitted. */
export const DEFAULT_MAX_ATTEMPTS = 3
