import type { RepoTarget } from '@holtkeeper/access'
import { type PeriodKind, featureTaskKinds } from '@holtkeeper/ai-usage'
import type {
  ReviewAnalytics,
  ReviewAnalyticsPhase,
  ReviewCostDay,
  ReviewLatency,
  ReviewMergeRequestCost,
  ReviewQualityRow,
  ReviewRepoRow,
  ReviewSizeClass,
  ReviewSizeRow,
  ReviewTrendDay,
} from '@holtkeeper/api'
import type { RepoRef } from '@holtkeeper/forge'
import { qualityRows, replyActions, reviewMetricsSchema, reviewPhases } from '@holtkeeper/review'
import type {
  AiUsageFilter,
  AiUsageStore,
  AnalysisStore,
  Job,
  JobStore,
  LearningStore,
  ReactionSignal,
} from '@holtkeeper/store'

import { REVIEWS_SCAN } from './reviews.ts'

const TOP_MERGE_REQUESTS = 10
const TOP_CATEGORIES = 8
const JOBS_PAGE = 200
const JOBS_SCAN = 2000
const severityKeys = ['critical', 'major', 'minor', 'info', 'unknown'] as const
const sizeClasses: readonly ReviewSizeClass[] = ['small', 'medium', 'large', 'huge']

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

/** The size class of a merge request whose human review is estimated at `minutes`. */
export function sizeClass(minutes: number): ReviewSizeClass {
  if (minutes < 15) return 'small'
  if (minutes < 60) return 'medium'
  if (minutes < 180) return 'large'
  return 'huge'
}

const ms = (values: number[]) => {
  const { median, p90 } = spread(values) ?? { median: 0, p90: 0 }
  return { medianMs: median, p90Ms: p90 }
}

const mean = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined

const isReply = (job: Job) => job.options.replyTo !== undefined || job.options.replies !== undefined

/** `ReviewLatency` of finished jobs; `undefined` when none has both a start and an end. */
export function latencyOf(jobs: readonly Job[]): ReviewLatency | undefined {
  const total: number[] = []
  const wait: number[] = []
  const run: number[] = []
  for (const job of jobs) {
    if (!job.startedAt || !job.finishedAt) continue
    const created = Date.parse(job.createdAt)
    const ready = Math.max(created, Date.parse(job.runAfter))
    const started = Date.parse(job.startedAt)
    const finished = Date.parse(job.finishedAt)
    total.push(finished - created)
    wait.push(Math.max(0, started - ready))
    run.push(finished - started)
  }
  if (!total.length) return undefined
  return { count: total.length, total: ms(total), wait: ms(wait), run: ms(run) }
}

/** Where `reviewAnalytics` reads from and what the caller may see. */
export interface ReviewAnalyticsSource {
  aiUsage: Pick<AiUsageStore, 'aggregate'>
  analyses: Pick<AnalysisStore, 'heads'>
  /** Review jobs, for how long reviews took; without it `speed` has no latencies. */
  jobs?: Pick<JobStore, 'list'>
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

  const [byPhase, byDay, byRequest, records, signals, jobs] = await Promise.all([
    source.aiUsage.aggregate({ ...span, groupBy: ['phase'], filter }),
    source.aiUsage.aggregate({ ...span, groupBy: ['day', 'phase'], filter }),
    source.aiUsage.aggregate({ ...span, groupBy: ['repo', 'mergeRequest', 'phase'], filter }),
    reviewRecords(source.analyses, readable, query.from, query.to),
    source.learnings ? source.learnings.reactions() : Promise.resolve([]),
    source.jobs ? reviewJobs(source.jobs, readable, query.from, query.to) : Promise.resolve([]),
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
  const repoSpend = new Map<string, { costUsd: number; mergeRequests: Set<number> }>()
  const repoEntry = (repo: string) => {
    const known = repoSpend.get(repo)
    if (known) return known
    const entry = { costUsd: 0, mergeRequests: new Set<number>() }
    repoSpend.set(repo, entry)
    return entry
  }
  let untrackedUsd = 0
  for (const bucket of byRequest) {
    const iid = Number(bucket.key.mergeRequest)
    const repo = bucket.key.repo ?? ''
    repoEntry(repo).costUsd += bucket.costUsd
    if (bucket.key.mergeRequest && Number.isInteger(iid)) repoEntry(repo).mergeRequests.add(iid)
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

  const trend = new Map<string, ReviewTrendDay>(
    [...days.values()].map((day) => [
      day.day,
      {
        day: day.day,
        costUsd: Object.values(day.phases).reduce((sum, cost) => sum + cost, 0),
        posted: records.postedByDay.get(day.day) ?? 0,
        judged: 0,
        fixed: 0,
        resolved: 0,
        ignored: 0,
      },
    ]),
  )
  for (const signal of merged) {
    const day = trend.get(signal.updatedAt.slice(0, 10))
    if (!day || !signal.outcome) continue
    day.judged += 1
    if (signal.outcome !== 'unknown') day[signal.outcome] += 1
  }

  const signalsByRepo = new Map<string, ReactionSignal[]>()
  for (const signal of merged)
    signalsByRepo.set(signal.repo, [...(signalsByRepo.get(signal.repo) ?? []), signal])
  for (const [repo, posted] of records.byRepo) {
    const entry = repoEntry(repo)
    for (const iid of posted.mergeRequests) entry.mergeRequests.add(iid)
  }
  for (const repo of signalsByRepo.keys()) repoEntry(repo)
  const repos: ReviewRepoRow[] = [...repoSpend.entries()]
    .filter(([repo]) => repo && readable(repoOf(repo)))
    .map(([repo, spend]) => {
      const judgedRow = qualityRows(signalsByRepo.get(repo) ?? [], 'category').total
      judgedRow.key = repo
      const row: ReviewRepoRow = {
        repo,
        mergeRequests: spend.mergeRequests.size,
        costUsd: spend.costUsd,
        posted: records.byRepo.get(repo)?.posted ?? 0,
        outcomes: judgedRow,
      }
      if (judgedRow.fixed > 0) row.costPerFixedUsd = spend.costUsd / judgedRow.fixed
      return row
    })
    .toSorted((a, b) => b.costUsd - a.costUsd || a.repo.localeCompare(b.repo))

  const severityRows = new Map(qualityRows(merged, 'severity').rows.map((row) => [row.key, row]))
  const bySeverity = severityKeys.flatMap((key): ReviewQualityRow[] => {
    const row = severityRows.get(key)
    return row ? [row] : []
  })
  const byCategory = qualityRows(merged, 'category').rows.slice(0, TOP_CATEGORIES)
  const perRequest = [...records.commentsByRequest.values()]
  const commented = perRequest.filter((count) => count > 0)
  const commentSpread = spread(commented)

  const reviewUsd = [...phaseCosts.values()].reduce((sum, entry) => sum + entry.costUsd, 0)
  const reviewLatency = latencyOf(jobs.filter((job) => !isReply(job)))
  const replyLatency = latencyOf(jobs.filter(isReply))
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
    trend: [...trend.values()],
    repos,
    noise: {
      bySeverity,
      byCategory,
      perMergeRequest: {
        reviewed: perRequest.length,
        clean: perRequest.length - commented.length,
        ...(commented.length && {
          meanComments: commented.reduce((sum, count) => sum + count, 0) / commented.length,
        }),
        ...(commentSpread && { p90Comments: commentSpread.p90 }),
      },
    },
    speed: {
      ...(reviewLatency && { reviews: reviewLatency }),
      ...(replyLatency && { replies: replyLatency }),
      bySize: records.bySize,
    },
    ...(records.partial && { partial: true as const }),
  }
}

/** Finished review jobs of readable repositories created in `[from, to)`, at most `JOBS_SCAN`. */
async function reviewJobs(
  jobs: Pick<JobStore, 'list'>,
  readable: (repo: RepoRef) => boolean,
  from: string,
  to: string,
): Promise<Job[]> {
  const found: Job[] = []
  let cursor: string | undefined = to
  for (let scanned = 0; scanned < JOBS_SCAN;) {
    // oxlint-disable-next-line no-await-in-loop -- each page starts where the previous one ended
    const page = await jobs.list({
      analyzer: 'review',
      status: 'succeeded',
      ...(cursor && { before: cursor }),
      limit: JOBS_PAGE,
    })
    scanned += page.length
    for (const job of page) if (job.createdAt >= from && readable(job.repo)) found.push(job)
    const oldest = page.at(-1)?.createdAt
    if (page.length < JOBS_PAGE || !oldest || oldest < from) break
    cursor = oldest
  }
  return found
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
    replies: { explain: 0, concede: 0, update: 0, fixed: 0, open: 0, unknown: 0 },
    skipped: 0,
  }
  const findings: ReviewAnalytics['findings'] = {
    posted: 0,
    severities: { critical: 0, major: 0, minor: 0, info: 0 },
    suggestions: 0,
    refuted: 0,
  }
  const titles = new Map<string, { title?: string; url?: string }>()
  const postedByDay = new Map<string, number>()
  const byRepo = new Map<string, { posted: number; mergeRequests: Set<number> }>()
  const commentsByRequest = new Map<string, number>()
  const sizes = new Map(
    sizeClasses.map((size) => [
      size,
      { reviews: 0, comments: 0, cost: [] as number[], duration: [] as number[] },
    ]),
  )
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
      const repo = `${head.repo.forge}:${head.repo.path}`
      const id = `${repo}!${metrics.mergeRequest}`
      const inRepo = byRepo.get(repo) ?? { posted: 0, mergeRequests: new Set<number>() }
      inRepo.mergeRequests.add(metrics.mergeRequest)
      byRepo.set(repo, inRepo)
      if (!titles.has(id))
        titles.set(id, {
          ...(metrics.title && { title: metrics.title }),
          ...(metrics.url && { url: metrics.url }),
        })
      if (metrics.mode === 'reply') {
        if (!metrics.replies) runs.replies.unknown += 1
        for (const action of replyActions) runs.replies[action] += metrics.replies?.[action] ?? 0
        continue
      }
      if (metrics.mode === 'skipped') {
        runs.skipped += 1
        continue
      }
      runs[metrics.mode] += 1
      inRepo.posted += metrics.comments
      const day = head.createdAt.slice(0, 10)
      postedByDay.set(day, (postedByDay.get(day) ?? 0) + metrics.comments)
      commentsByRequest.set(id, (commentsByRequest.get(id) ?? 0) + metrics.comments)
      if (metrics.mode === 'full' && metrics.reviewMinutes !== undefined) {
        const size = sizes.get(sizeClass(metrics.reviewMinutes))
        if (size) {
          size.reviews += 1
          size.comments += metrics.comments
          if (metrics.costUsd !== undefined) size.cost.push(metrics.costUsd)
          if (metrics.durationMs !== undefined) size.duration.push(metrics.durationMs)
        }
      }
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
  const bySize: ReviewSizeRow[] = sizeClasses.map((size) => {
    const entry = sizes.get(size) ?? { reviews: 0, comments: 0, cost: [], duration: [] }
    const row: ReviewSizeRow = {
      size,
      reviews: entry.reviews,
      meanComments: entry.reviews ? entry.comments / entry.reviews : 0,
    }
    const meanCostUsd = mean(entry.cost)
    const meanDurationMs = mean(entry.duration)
    if (meanCostUsd !== undefined) row.meanCostUsd = meanCostUsd
    if (meanDurationMs !== undefined) row.meanDurationMs = meanDurationMs
    return row
  })
  return {
    runs,
    findings,
    titles,
    postedByDay,
    byRepo,
    commentsByRequest,
    bySize,
    partial: !exhausted,
  }
}
