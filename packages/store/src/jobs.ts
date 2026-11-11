import type { Timestamp } from './types.ts'

/** The latest `runAfter` a claim at `now` may take under `ClaimRules.delayMs`. */
export const claimDueBy = (now: Timestamp, delayMs = 0): Timestamp =>
  delayMs > 0 ? new Date(Date.parse(now) - delayMs).toISOString() : now

/** Attempts a job gets when `NewJob.maxAttempts` is omitted. */
export const DEFAULT_MAX_ATTEMPTS = 3

/** The error `JobStore.recoverStale` records for jobs whose worker died. */
export const STALE_JOB_ERROR = 'worker stopped responding'

/** Longest `errorSignature` kept. */
const SIGNATURE_LENGTH = 200

/**
 * The first non-empty line of `error` with what differs between occurrences of the same failure
 * replaced by placeholders: URLs, UUIDs, hex hashes, file paths and numbers. Equal failures in
 * different repositories, runs or attempts get the same signature.
 */
export function errorSignature(error: string): string {
  const first = error
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
  if (!first) return ''
  return first
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi, '<hash>')
    .replace(/(?:[a-z]:)?(?:[\w.@~-]*[/\\])+[\w.@~-]+[/\\]?/gi, (match) =>
      match.startsWith('<') ? match : '<path>',
    )
    .replace(/\d+/g, '<n>')
    .replace(/(?:<n>[.:,]?)+<n>/g, '<n>')
    .replace(/\s+/g, ' ')
    .slice(0, SIGNATURE_LENGTH)
}
