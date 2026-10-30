import type { MergeRequestRecord } from '@holtkeeper/forge'
import type { Tone } from '@holtkeeper/report'

import {
  byTime,
  distribution,
  median,
  round,
  secondsBetween,
  weekOf,
  weeksOf,
  within,
} from './stats.ts'
import type {
  Band,
  DeliveryInput,
  DeliveryOptions,
  DeploySource,
  DoraData,
  FailureSignal,
} from './types.ts'

/** One production release, whichever source it was derived from. */
export interface DeployEvent {
  at: string
  status: 'success' | 'failed'
  label: string
}

const HOUR = 3600
const DAY = 24 * HOUR
const WEEK = 7 * DAY

/**
 * Production releases in the window, oldest first. Deployments to the production environment
 * when there are any; otherwise tags (creation or commit date); otherwise successful pipelines on
 * the default branch. Only real deployments can fail.
 */
export function deployEvents(input: DeliveryInput): {
  source: DeploySource
  events: DeployEvent[]
} {
  const { from, to } = input
  const deployments = input.deployments
    .filter((d) => d.status === 'success' || d.status === 'failed')
    .map((d) => ({
      at: d.finishedAt ?? d.createdAt,
      status: d.status === 'success' ? ('success' as const) : ('failed' as const),
      label: d.ref ? `${d.ref} @ ${d.sha.slice(0, 8)}` : d.sha.slice(0, 8),
    }))
    .filter((d) => within(d.at, from, to))
  const sorted = (events: DeployEvent[]) => events.toSorted((a, b) => byTime(a.at, b.at))
  if (deployments.length > 0) return { source: 'deployments', events: sorted(deployments) }

  const tags = input.tags
    .map((t) => ({ at: t.createdAt ?? t.committedAt, status: 'success' as const, label: t.name }))
    .filter((t) => within(t.at, from, to))
  if (tags.length > 0) return { source: 'tags', events: sorted(tags) }

  const pipelines = input.pipelines
    .filter((p) => p.ref === input.defaultBranch && p.status === 'success')
    .map((p) => ({
      at: p.finishedAt ?? p.updatedAt ?? p.createdAt,
      status: 'success' as const,
      label: `pipeline #${p.id}`,
    }))
    .filter((p) => within(p.at, from, to))
  if (pipelines.length > 0) return { source: 'pipelines', events: sorted(pipelines) }
  return { source: 'none', events: [] }
}

const REVERT_TITLE = /^\s*(?:revert|rollback|roll back)\b/i
const REVERT_LABEL = /^(?:revert|rollback)$/i
const HOTFIX_LABEL = /hotfix/i
const HOTFIX_BRANCH = /^hotfix[/_-]/i

/** Whether a merge request reverts or rolls back a change. */
export const isRevert = (mr: MergeRequestRecord) =>
  REVERT_TITLE.test(mr.title) || mr.labels.some((label) => REVERT_LABEL.test(label))

/** Whether a merge request is a hotfix (label containing `hotfix`, or a `hotfix/` branch). */
export const isHotfix = (mr: MergeRequestRecord) =>
  mr.labels.some((label) => HOTFIX_LABEL.test(label)) || HOTFIX_BRANCH.test(mr.sourceBranch)

/** Failed deployments plus revert and hotfix merge requests merged into the default branch. */
export function failureSignals(input: DeliveryInput, events: DeployEvent[]): FailureSignal[] {
  const signals: FailureSignal[] = events
    .filter((event) => event.status === 'failed')
    .map((event) => ({
      kind: 'deployment',
      at: event.at,
      fixedAfter: event.at,
      title: `Failed deployment ${event.label}`,
    }))
  for (const mr of input.mergeRequests) {
    if (mr.state !== 'merged' || !mr.mergedAt || mr.targetBranch !== input.defaultBranch) continue
    const kind = isRevert(mr) ? 'revert' : isHotfix(mr) ? 'hotfix' : undefined
    if (!kind || !within(mr.createdAt, input.from, input.to)) continue
    signals.push({
      kind,
      at: mr.createdAt,
      fixedAfter: mr.mergedAt,
      title: mr.title,
      href: mr.webUrl,
    })
  }
  return signals.toSorted((a, b) => byTime(a.at, b.at))
}

/**
 * Blames each signal on the last successful release at or before it, if that release is at most
 * `windowHours` older, and returns the blamed releases' indexes into `events`.
 */
export function blameFailures(
  events: DeployEvent[],
  signals: FailureSignal[],
  windowHours: number,
): Set<number> {
  const failed = new Set<number>()
  for (const signal of signals) {
    let blamed = -1
    events.forEach((event, index) => {
      if (event.status === 'success' && byTime(event.at, signal.at) <= 0) blamed = index
    })
    const event = events[blamed]
    if (!event || secondsBetween(event.at, signal.at) > windowHours * HOUR) continue
    failed.add(blamed)
    signal.blamedOn = event.label
  }
  return failed
}

/**
 * Time to restore: from each failure to the first successful release after its fix. Failures that
 * start before the previous one is restored are one incident.
 */
export function restoreTimes(
  events: DeployEvent[],
  signals: FailureSignal[],
): { durations: number[]; incidents: number; unresolved: number } {
  const durations: number[] = []
  let incidents = 0
  let unresolved = 0
  let current: { start: string; until: string | undefined } | undefined
  const finish = () => {
    if (!current) return
    incidents++
    if (current.until) durations.push(secondsBetween(current.start, current.until))
    else unresolved++
  }
  for (const signal of signals) {
    const restored = events.find(
      (e) => e.status === 'success' && byTime(e.at, signal.fixedAfter) > 0,
    )
    if (restored) signal.restoreSeconds = round(secondsBetween(signal.at, restored.at))
    if (current && (current.until === undefined || byTime(signal.at, current.until) < 0)) {
      if (current.until !== undefined)
        current.until =
          restored && byTime(restored.at, current.until) > 0
            ? restored.at
            : restored
              ? current.until
              : undefined
      continue
    }
    finish()
    current = { start: signal.at, until: restored?.at }
  }
  finish()
  return { durations, incidents, unresolved }
}

/** DORA deployment frequency band from releases per week. */
export function frequencyBand(perWeek: number): Band {
  if (perWeek >= 7) return 'elite'
  if (perWeek >= 1) return 'high'
  if (perWeek >= 12 / 52) return 'medium'
  return 'low'
}

/** DORA lead time band from seconds. */
export function leadTimeBand(seconds: number): Band {
  if (seconds < DAY) return 'elite'
  if (seconds < WEEK) return 'high'
  if (seconds < 30 * DAY) return 'medium'
  return 'low'
}

/** DORA change failure rate band from a percentage. */
export function failureRateBand(percent: number): Band {
  if (percent <= 5) return 'elite'
  if (percent <= 10) return 'high'
  if (percent <= 15) return 'medium'
  return 'low'
}

/** DORA time to restore band from seconds. */
export function restoreBand(seconds: number): Band {
  if (seconds < HOUR) return 'elite'
  if (seconds < DAY) return 'high'
  if (seconds < WEEK) return 'medium'
  return 'low'
}

/** Report tone of a band. */
export const bandTone: Record<Band, Tone> = {
  elite: 'good',
  high: 'info',
  medium: 'warning',
  low: 'bad',
}

interface LeadTime {
  mergedAt: string
  deployedAt?: string
  lead?: number
  merge: number
  deploy?: number
}

function leadTimes(input: DeliveryInput, events: DeployEvent[]): LeadTime[] {
  const successes = events.filter((e) => e.status === 'success')
  return input.mergeRequests
    .filter(
      (mr) =>
        mr.state === 'merged' &&
        mr.targetBranch === input.defaultBranch &&
        within(mr.mergedAt, input.from, input.to),
    )
    .map((mr) => {
      const mergedAt = mr.mergedAt ?? mr.updatedAt
      const start = mr.firstCommitAt ?? mr.createdAt
      const deployed = successes.find((e) => byTime(e.at, mergedAt) >= 0)
      const result: LeadTime = { mergedAt, merge: secondsBetween(mr.createdAt, mergedAt) }
      if (deployed) {
        result.deployedAt = deployed.at
        result.lead = secondsBetween(start, deployed.at)
        result.deploy = secondsBetween(mergedAt, deployed.at)
      }
      return result
    })
}

const defined = (values: (number | undefined)[]) => values.filter((v) => v !== undefined)

/** The four DORA metrics, their bands and a weekly breakdown. */
export function computeDora(input: DeliveryInput, options: DeliveryOptions): DoraData {
  const { source, events } = deployEvents(input)
  const signals = failureSignals(input, events)
  const failed = blameFailures(events, signals, options.failureWindowHours)
  const restore = restoreTimes(events, signals)
  const leads = leadTimes(input, events)
  const successes = events.filter((e) => e.status === 'success').length
  const weeks = Math.max(secondsBetween(input.from, input.to) / WEEK, 1 / 7)
  const perWeek = round(successes / weeks)

  const leadTime = distribution(defined(leads.map((l) => l.lead)))
  const timeToRestore = {
    ...distribution(restore.durations),
    incidents: restore.incidents,
    unresolved: restore.unresolved,
  }
  const changeFailureRate = successes > 0 ? round((failed.size / successes) * 100) : undefined

  const bands: DoraData['bands'] = { deploymentFrequency: frequencyBand(perWeek) }
  if (leadTime.median !== undefined) bands.leadTime = leadTimeBand(leadTime.median)
  if (changeFailureRate !== undefined) bands.changeFailureRate = failureRateBand(changeFailureRate)
  if (timeToRestore.median !== undefined) bands.timeToRestore = restoreBand(timeToRestore.median)

  const weekly = weeksOf(input.from, input.to).map((week) => {
    const deployed = leads.filter((l) => l.deployedAt && weekOf(l.deployedAt) === week)
    const leadMedian = median(defined(deployed.map((l) => l.lead)))
    return {
      week,
      deployments: events.filter((e) => e.status === 'success' && weekOf(e.at) === week).length,
      failedChanges: [...failed].filter((i) => {
        const event = events[i]
        return event !== undefined && weekOf(event.at) === week
      }).length,
      ...(leadMedian === undefined ? {} : { leadTimeMedian: round(leadMedian) }),
    }
  })

  return {
    source,
    deployments: successes,
    failedDeployments: events.length - successes,
    deploymentsPerWeek: perWeek,
    leadTime,
    timeToMerge: distribution(leads.map((l) => l.merge)),
    timeToDeploy: distribution(defined(leads.map((l) => l.deploy))),
    undeployed: leads.filter((l) => l.deployedAt === undefined).length,
    failedChanges: failed.size,
    ...(changeFailureRate === undefined ? {} : { changeFailureRate }),
    timeToRestore,
    bands,
    weeks: weekly,
    failures: signals,
  }
}
