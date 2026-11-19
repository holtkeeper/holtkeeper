import type { RepoTarget } from '@holtkeeper/access'
import { type PeriodKind, featureTaskKinds } from '@holtkeeper/ai-usage'
import type {
  ReviewAnalytics,
  ReviewAnalyticsPhase,
  ReviewCostDay,
  ReviewMergeRequestCost,
} from '@holtkeeper/api'
import type { RepoRef } from '@holtkeeper/forge'
import { qualityRows, reviewMetricsSchema, reviewPhases } from '@holtkeeper/review'
import type { AiUsageFilter, AiUsageStore, AnalysisStore, LearningStore } from '@holtkeeper/store'

import { REVIEWS_SCAN } from './reviews.ts'

const TOP_MERGE_REQUESTS = 10

const HEADS_PAGE = 200
const DAY_MS = 86_400_000

const phases: readonly ReviewAnalyticsPhase[] = [...reviewPhases, 'other']

const phaseOf = (value: string | undefined): ReviewAnalyticsPhase =>
  phases.find((phase) => phase !== 'other' && phase === value) ?? 'other'

/** The UTC days from `from` to `to`, both included, as `YYYY-MM-DD`. */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = []
  const last = to.slice(0, 10)
  for (let at = Date.parse(`${from.slice(0, 10)}T00:00:00.000Z`); ; at += DAY_MS) {
    const day = new Date(at).toISOString().slice(0, 10)
    if (day > last) break
    days.push(day)
  }
  return days
}

/** The median and the nearest-rank 90th percentile of `values`; `undefined` when empty. */
export function spread(values: readonly number[]): { median: number; p90: number } | undefined {
  if (!values.length) return undefined
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2
      ? (sorted[middle] ?? 0)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
  const p90 = sorted[Math.max(0, Math.ceil(sorted.length * 0.9) - 1)] ?? 0
  return { median, p90 }
}

/** Where `reviewAnalytics` reads from and what the caller may see. */
export interface ReviewAnalyticsSource {
  aiUsage: Pick<AiUsageStore, 'aggregate'>
  analyses: Pick<AnalysisStore, 'heads'>
  learnings?: Pick<LearningStore, 'reactions'>
  targetOf: (repo: RepoRef) => RepoTarget
  /** Whether the caller may read the review records and comments of a repository. */
  canRead: (target: RepoTarget) => boolean
}

/** The period and what to narrow to. */
export interface ReviewAnalyticsQuery {
  kind: PeriodKind
  from: string
  to: string
  /** The caller's AI usage access (`scopes`, `teams`); spend never reaches past it. */
  access: AiUsageFilter
  /** Team keys review records and comments are narrowed to, as `access.teams`. */
  teams?: readonly string[]
}

const repoOf = (key: string): RepoRef => {
  const split = key.indexOf(':')
  return { forge: key.slice(0, split), path: key.slice(split + 1) }
}

/**
 * `ReviewAnalytics` over one period: spend from AI usage records of the reviews feature, runs
 * and findings from review records (at most `REVIEWS_SCAN` of them), outcomes from the comment
 * signals of merged merge requests read since the period's start. Asks no forge or model.
 */
export async function reviewAnalytics(
  source: ReviewAnalyticsSource,
  query: ReviewAnalyticsQuery,
): Promise<ReviewAnalytics> {
  const filter: AiUsageFilter = {
    ...query.access,
    taskKinds: [...featureTaskKinds.reviews],
  }
  const span = { from: query.from, to: query.to }
  const visible = new Map<string, boolean>()
  const readable = (repo: RepoRef) => {
    const key = `${repo.forge}:${repo.path}`
    const known = visible.get(key)
    if (known !== undefined) return known
    const target = source.targetOf(repo)
    const allowed =
      source.canRead(target) &&
      (!query.teams || query.teams.some((team) => target.teams.includes(team)))
    visible.set(key, allowed)
    return allowed
  }

  const [byPhase, byDay, byRequest, records, signals] = await Promise.all([
    source.aiUsage.aggregate({ ...span, groupBy: ['phase'], filter }),
    source.aiUsage.aggregate({ ...span, groupBy: ['day', 'phase'], filter }),
    source.aiUsage.aggregate({ ...span, groupBy: ['repo', 'mergeRequest', 'phase'], filter }),
    reviewRecords(source.analyses, readable, query.from, query.to),
    source.learnings ? source.learnings.reactions() : Promise.resolve([]),
  ])

  const phaseCosts = new Map(phases.map((phase) => [phase, { phase, costUsd: 0, runs: 0 }]))
  for (const bucket of byPhase) {
    const entry = phaseCosts.get(phaseOf(bucket.key.phase))
    if (!entry) continue
    entry.costUsd += bucket.costUsd
    entry.runs += bucket.runs
  }

  const days = new Map<string, ReviewCostDay>(
    daysBetween(query.from, query.to).map((day) => [day, { day, phases: {} }]),
  )
  for (const bucket of byDay) {
    const day = days.get(bucket.key.day ?? '')
    if (!day) continue
    const phase = phaseOf(bucket.key.phase)
    day.phases[phase] = (day.phases[phase] ?? 0) + bucket.costUsd
  }

  const requests = new Map<string, ReviewMergeRequestCost>()
  let untrackedUsd = 0
  for (const bucket of byRequest) {
    const iid = Number(bucket.key.mergeRequest)
    const repo = bucket.key.repo ?? ''
    if (!bucket.key.mergeRequest || !Number.isInteger(iid)) {
      untrackedUsd += bucket.costUsd
      continue
    }
    const id = `${repo}!${iid}`
    const entry = requests.get(id) ?? { repo, mergeRequest: iid, costUsd: 0, runs: 0, phases: {} }
    entry.costUsd += bucket.costUsd
    entry.runs += bucket.runs
    const phase = phaseOf(bucket.key.phase)
    entry.phases[phase] = (entry.phases[phase] ?? 0) + bucket.costUsd
    requests.set(id, entry)
  }
  const costs = [...requests.values()].map((entry) => entry.costUsd)
  const requestsUsd = costs.reduce((sum, cost) => sum + cost, 0)
  const middle = spread(costs)
  const top = [...requests.values()]
    .toSorted((a, b) => b.costUsd - a.costUsd)
    .slice(0, TOP_MERGE_REQUESTS)
  for (const entry of top) {
    const known = records.titles.get(`${entry.repo}!${entry.mergeRequest}`)
    if (known?.title) entry.title = known.title
    if (known?.url) entry.url = known.url
  }

  const judged = signals.filter(
    (signal) =>
      signal.updatedAt >= query.from &&
      signal.updatedAt < query.to &&
      readable(repoOf(signal.repo)),
  )
  const merged = judged.filter(
    (signal) => signal.mergeRequestState === 'merged' && signal.outcome !== undefined,
  )
  const { total } = qualityRows(merged, 'category')
  const outcomes = {
    ...total,
    discussed: merged.filter((signal) => (signal.humanReplies ?? 0) > 0).length,
  }

  const reviewUsd = [...phaseCosts.values()].reduce((sum, entry) => sum + entry.costUsd, 0)
  return {
    period: { kind: query.kind, from: query.from, to: query.to },
    phases: [...phaseCosts.values()],
    days: [...days.values()],
    mergeRequests: {
      count: costs.length,
      costUsd: requestsUsd,
      ...(costs.length && { meanUsd: requestsUsd / costs.length }),
      ...(middle && { medianUsd: middle.median, p90Usd: middle.p90 }),
      top,
      untrackedUsd,
    },
    runs: records.runs,
    findings: records.findings,
    outcomes,
    ...(outcomes.fixed > 0 && { costPerFixedUsd: reviewUsd / outcomes.fixed }),
    ...(records.partial && { partial: true as const }),
  }
}

/** Counts over the readable review records created in `[from, to)`, newest first. */
async function reviewRecords(
  analyses: Pick<AnalysisStore, 'heads'>,
  readable: (repo: RepoRef) => boolean,
  from: string,
  to: string,
) {
  const runs: ReviewAnalytics['runs'] = {
    full: 0,
    incremental: 0,
    replies: { explain: 0, concede: 0, update: 0, unknown: 0 },
    skipped: 0,
  }
  const findings: ReviewAnalytics['findings'] = {
    posted: 0,
    severities: { critical: 0, major: 0, minor: 0, info: 0 },
    suggestions: 0,
    refuted: 0,
  }
  const titles = new Map<string, { title?: string; url?: string }>()
  let cursor: string | undefined
  let scanned = 0
  let exhausted = false
  while (scanned < REVIEWS_SCAN) {
    const take = Math.min(HEADS_PAGE, REVIEWS_SCAN - scanned)
    // oxlint-disable-next-line no-await-in-loop -- each page starts where the previous one ended
    const heads = await analyses.heads({
      kind: 'review',
      since: from,
      ...(cursor ? { before: cursor } : {}),
      limit: take,
    })
    scanned += heads.length
    exhausted = heads.length < take
    for (const head of heads) {
      if (head.createdAt >= to || !readable(head.repo)) continue
      const metrics = reviewMetricsSchema.safeParse(head.metrics).data
      if (!metrics) continue
      const id = `${head.repo.forge}:${head.repo.path}!${metrics.mergeRequest}`
      if (!titles.has(id))
        titles.set(id, {
          ...(metrics.title && { title: metrics.title }),
          ...(metrics.url && { url: metrics.url }),
        })
      if (metrics.mode === 'reply') {
        runs.replies[metrics.reply ?? 'unknown'] += 1
        continue
      }
      if (metrics.mode === 'skipped') {
        runs.skipped += 1
        continue
      }
      runs[metrics.mode] += 1
      findings.posted += metrics.comments
      findings.suggestions += metrics.suggestions
      findings.refuted += metrics.refuted ?? 0
      findings.severities.critical += metrics.severities.critical
      findings.severities.major += metrics.severities.major
      findings.severities.minor += metrics.severities.minor
      findings.severities.info += metrics.severities.info
    }
    cursor = heads.at(-1)?.createdAt ?? cursor
    if (exhausted) break
  }
  return { runs, findings, titles, partial: !exhausted }
}
