import type { AnalyzerRefresh } from '@holtkeeper/analyzer'
import type { Job } from '@holtkeeper/store'

import { everyMs, isAllowedAt, nextRuns } from './smart.ts'

/** How long a default-branch head must stay put before change-class analyzers rerun on it. */
export const FRESHNESS_DEBOUNCE_MS = 30 * 60_000

/** A team's freshness override: `off` stops it, `slower` stretches every interval by `factor`. */
export interface FreshnessMode {
  mode: 'on' | 'off' | 'slower'
  factor: number
}

/** The hours heavy analyzers are held to, local wall-clock `HH:MM`; `from > to` crosses midnight. */
export interface NightWindow {
  from: string
  to: string
}

/** What `decideFreshness` knows about one analyzer on one repository or group. */
export interface FreshnessInput {
  refresh: AnalyzerRefresh
  /** The analyzer can call an LLM: it never runs without a record that names its commit. */
  ai: boolean
  /** Newest record of the analysis, if any. */
  latest?: { sha?: string; createdAt: string }
  /** Default-branch head and when it was first seen; absent while unknown. */
  head?: { sha: string; at: string }
  /** A job of this analyzer for the target is queued or running. */
  active?: boolean
  /** The newest job freshness queued for the target. */
  lastJob?: Pick<Job, 'id' | 'status' | 'createdAt'>
  /**
   * `false` when the analyzer lists `refresh.paths` and no file matching them changed between the
   * record's commit and the head; absent when unknown or not asked.
   */
  pathsChanged?: boolean
  mode: FreshnessMode
}

export interface FreshnessContext {
  now: Date
  nightWindow: NightWindow
  /** IANA zone of the night window. */
  timezone: string
  /** Default `FRESHNESS_DEBOUNCE_MS`. */
  debounceMs?: number
}

/**
 * What freshness does with one analyzer on one target now. `run`: queue a job, with `reason`.
 * `wait`: stale or due, but not yet; `nextAt` says when it may run when known. `fresh`: nothing to
 * do; `nextAt` is when a time-class analyzer comes due. `skip`: freshness does not run it.
 */
export type FreshnessDecision =
  | { action: 'run'; reason: string }
  | { action: 'wait'; reason: string; nextAt?: string }
  | { action: 'fresh'; reason: string; nextAt?: string }
  | { action: 'skip'; reason: string }

const short = (sha: string) => sha.slice(0, 7)

const iso = (ms: number) => new Date(ms).toISOString()

const allDays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

/** Whether `at` falls into the night window in `timezone`. */
export function inNightWindow(at: Date, window: NightWindow, timezone: string): boolean {
  return isAllowedAt(
    { windows: { allow: [{ days: [...allDays], from: window.from, to: window.to }] } },
    at,
    { timezone },
  )
}

/** Start of the next night window after `at`. */
function nextNight(at: Date, window: NightWindow, timezone: string): string | undefined {
  const [hours, minutes] = window.from.split(':').map(Number)
  return nextRuns({ cron: `${minutes} ${hours} * * *`, timezone }, at, 1)[0]?.toISOString()
}

/** `refresh`'s interval in milliseconds with the team's `slower` factor applied. */
export function refreshIntervalMs(refresh: AnalyzerRefresh, mode: FreshnessMode): number {
  const base = everyMs(refresh.on === 'change' ? refresh.minInterval : refresh.cadence)
  return mode.mode === 'slower' ? Math.round(base * mode.factor) : base
}

const intervalText = (refresh: AnalyzerRefresh, mode: FreshnessMode) => {
  const base = refresh.on === 'change' ? refresh.minInterval : refresh.cadence
  return mode.mode === 'slower' ? `${base} x${mode.factor}` : base
}

/**
 * Decides one analyzer on one target, in this order: a team that turned freshness off, a job
 * already queued or running, then staleness. `change` analyzers are stale when the head differs
 * from the record's `sha` (a record without one counts as stale, except for `ai` analyzers, which
 * then wait for an event or a person), the head has stayed put for the debounce and `minInterval`
 * has passed since the record. `time` analyzers are due once `cadence` passed. A freshness job
 * that ended without success holds the next try back by the same interval, so a failing analyzer
 * does not come back on every sweep. Heavy analyzers then wait for the night window.
 */
export function decideFreshness(
  input: FreshnessInput,
  context: FreshnessContext,
): FreshnessDecision {
  const { refresh, latest, head, mode } = input
  const now = context.now.getTime()
  if (mode.mode === 'off') return { action: 'skip', reason: 'freshness is off for this team' }
  if (input.active) return { action: 'wait', reason: 'a job is already queued or running' }
  const interval = refreshIntervalMs(refresh, mode)
  const since = latest ? Date.parse(latest.createdAt) : undefined

  let reason: string
  if (refresh.on === 'change') {
    if (!head) return { action: 'wait', reason: 'the default-branch head is not known yet' }
    if (latest?.sha === head.sha)
      return { action: 'fresh', reason: `the record describes head ${short(head.sha)}` }
    if (input.ai && !latest?.sha)
      return {
        action: 'skip',
        reason: latest
          ? 'calls an LLM and its record names no commit; it runs on events or by hand'
          : 'calls an LLM and has no record yet; it runs on events or by hand',
      }
    if (input.pathsChanged === false && latest?.sha)
      return {
        action: 'fresh',
        reason: `no file it reads changed between ${short(latest.sha)} and ${short(head.sha)}`,
      }
    const debounce = context.debounceMs ?? FRESHNESS_DEBOUNCE_MS
    const settled = Date.parse(head.at) + debounce
    if (now < settled)
      return {
        action: 'wait',
        reason: `the head moved less than ${Math.round(debounce / 60_000)} minutes ago`,
        nextAt: iso(settled),
      }
    if (since !== undefined && now < since + interval)
      return {
        action: 'wait',
        reason: `minInterval ${intervalText(refresh, mode)} has not passed since the record`,
        nextAt: iso(since + interval),
      }
    reason = latest
      ? latest.sha
        ? `sha ${short(latest.sha)} != head ${short(head.sha)}`
        : `record has no sha, head ${short(head.sha)}`
      : `no record yet, head ${short(head.sha)}`
  } else {
    if (input.ai && !latest?.sha)
      return { action: 'skip', reason: 'calls an LLM and has no record with a commit yet' }
    if (since !== undefined && now < since + interval)
      return {
        action: 'fresh',
        reason: `cadence ${intervalText(refresh, mode)} has not passed`,
        nextAt: iso(since + interval),
      }
    reason = latest ? `cadence ${intervalText(refresh, mode)} elapsed` : 'no record yet'
  }

  const last = input.lastJob
  if (last && last.status !== 'succeeded') {
    const retry = Date.parse(last.createdAt) + interval
    if (now < retry)
      return {
        action: 'wait',
        reason: `the last freshness job ${last.id} ended ${last.status}`,
        nextAt: iso(retry),
      }
  }
  if (refresh.heavy && !inNightWindow(context.now, context.nightWindow, context.timezone)) {
    const night = nextNight(context.now, context.nightWindow, context.timezone)
    return {
      action: 'wait',
      reason: 'heavy: runs only in the night window',
      ...(night !== undefined && { nextAt: night }),
    }
  }
  return { action: 'run', reason }
}

/** Whether any of `files` matches one of `globs` (paths from the repository root). */
export function matchesAnyPath(files: readonly string[], globs: readonly string[]): boolean {
  const patterns = globs.map((glob) => new Bun.Glob(glob))
  return files.some((file) => patterns.some((pattern) => pattern.match(file)))
}
