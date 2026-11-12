import type { RepoTarget } from '@holtkeeper/access'
import type { ReviewDetail, ReviewList, ReviewRow, ReviewWindowTotals } from '@holtkeeper/api'
import type { RepoRef } from '@holtkeeper/forge'
import type { ResolvedGuide } from '@holtkeeper/guide'
import { type ReviewData, reviewMetrics, reviewMetricsSchema } from '@holtkeeper/review'
import type { AnalysisHead, AnalysisRecord, AnalysisStore } from '@holtkeeper/store'

/** Rows `GET /api/reviews` returns by default and at most. */
export const REVIEWS_LIMIT = { default: 50, max: 200 }

/** Review heads one `GET /api/reviews` request reads at most, however many it filters out. */
export const REVIEWS_SCAN = 1000

const scopeRank = (scope: string) =>
  scope === 'all' ? 0 : scope.startsWith('group:') ? 1 : scope.startsWith('family:') ? 2 : 3

/** Guide scopes whose text reached a resolved Guide, broad to narrow, each once. */
export function guideScopesOf(guide: Pick<ResolvedGuide, 'blocks'>): string[] {
  const scopes = guide.blocks.flatMap((block) =>
    block.scope && block.chars > 0 ? [block.scope] : [],
  )
  return [...new Set(scopes)].toSorted((a, b) => scopeRank(a) - scopeRank(b))
}

/** The Reviews table row of a review head, from its stored metrics; none without readable ones. */
function reviewRowOf(head: Pick<AnalysisHead, 'id' | 'repo' | 'createdAt' | 'metrics'>) {
  const metrics = reviewMetricsSchema.safeParse(head.metrics).data
  if (!metrics) return undefined
  const row: ReviewRow = {
    analysisId: head.id,
    repo: head.repo,
    createdAt: head.createdAt,
    mergeRequest: {
      iid: metrics.mergeRequest,
      title: metrics.title ?? `!${metrics.mergeRequest}`,
      url: metrics.url ?? '',
      ...(metrics.author ? { author: metrics.author } : {}),
    },
    mode: metrics.mode,
    verdict: metrics.verdict,
    findings: metrics.comments,
    severities: metrics.severities,
    resolved: metrics.resolved,
    ...(metrics.model ? { model: metrics.model } : {}),
    ...(metrics.durationMs === undefined ? {} : { durationMs: metrics.durationMs }),
    guideScopes: metrics.guideScopes ?? [],
    ...(metrics.costUsd === undefined ? {} : { costUsd: metrics.costUsd }),
  }
  return row
}

/** What `listReviews` filters by; `since` and `limit` are already defaulted and capped. */
export interface ReviewFilter {
  repo?: RepoRef
  group?: string
  verdict?: ReviewRow['verdict']
  since: string
  before?: string
  limit: number
}

/**
 * Review runs newest first on repositories `canRead` allows, from stored metrics only (records
 * without readable metrics are left out). Reads heads in pages of `limit + 1` and stops after
 * `REVIEWS_SCAN` heads; `nextBefore` is set whenever older rows may follow, also when the scan
 * stopped before filling the page.
 */
export async function listReviews(
  source: {
    analyses: Pick<AnalysisStore, 'heads'>
    targetOf: (repo: RepoRef) => RepoTarget
  },
  canRead: (target: RepoTarget) => boolean,
  filter: ReviewFilter,
): Promise<ReviewList> {
  const rows: ReviewRow[] = []
  let cursor = filter.before
  let scanned = 0
  let exhausted = false
  while (rows.length <= filter.limit && scanned < REVIEWS_SCAN) {
    const take = Math.min(filter.limit + 1, REVIEWS_SCAN - scanned)
    // oxlint-disable-next-line no-await-in-loop -- each page starts where the previous one ended
    const heads = await source.analyses.heads({
      kind: 'review',
      ...(filter.repo ? { repo: filter.repo } : {}),
      since: filter.since,
      ...(cursor ? { before: cursor } : {}),
      limit: take,
    })
    scanned += heads.length
    exhausted = heads.length < take
    for (const head of heads) {
      const target = source.targetOf(head.repo)
      if (!canRead(target)) continue
      if (filter.group && !target.groups.includes(filter.group)) continue
      const row = reviewRowOf(head)
      if (!row || (filter.verdict && row.verdict !== filter.verdict)) continue
      rows.push(row)
    }
    cursor = heads.at(-1)?.createdAt ?? cursor
    if (exhausted) break
  }
  const reviews = rows.slice(0, filter.limit)
  const window = filter.before ? undefined : await windowTotals(source, canRead, filter)
  const nextBefore =
    rows.length > filter.limit ? reviews.at(-1)?.createdAt : exhausted ? undefined : cursor
  const totals = { reviews: reviews.length, findings: 0, resolved: 0, costUsd: 0 }
  for (const review of reviews) {
    totals.findings += review.findings
    totals.resolved += review.resolved
    totals.costUsd += review.costUsd ?? 0
  }
  return { reviews, totals, ...(window ? { window } : {}), ...(nextBefore ? { nextBefore } : {}) }
}

const WINDOW_PAGE = 200

/**
 * Sums over every review head of the window `filter` matches (repository, group, verdict, since),
 * from stored metrics, reading at most `REVIEWS_SCAN` heads; `partial` when it stopped there.
 */
async function windowTotals(
  source: { analyses: Pick<AnalysisStore, 'heads'>; targetOf: (repo: RepoRef) => RepoTarget },
  canRead: (target: RepoTarget) => boolean,
  filter: ReviewFilter,
): Promise<ReviewWindowTotals> {
  const totals: ReviewWindowTotals = {
    reviews: 0,
    verdicts: { 'looks-good': 0, 'needs-changes': 0, skipped: 0 },
    findings: 0,
    severities: { critical: 0, major: 0, minor: 0, info: 0 },
    resolved: 0,
    costUsd: 0,
  }
  let cursor: string | undefined
  let scanned = 0
  let exhausted = false
  while (scanned < REVIEWS_SCAN) {
    const take = Math.min(WINDOW_PAGE, REVIEWS_SCAN - scanned)
    // oxlint-disable-next-line no-await-in-loop -- each page starts where the previous one ended
    const heads = await source.analyses.heads({
      kind: 'review',
      ...(filter.repo ? { repo: filter.repo } : {}),
      since: filter.since,
      ...(cursor ? { before: cursor } : {}),
      limit: take,
    })
    scanned += heads.length
    exhausted = heads.length < take
    for (const head of heads) {
      const target = source.targetOf(head.repo)
      if (!canRead(target) || (filter.group && !target.groups.includes(filter.group))) continue
      const row = reviewRowOf(head)
      if (!row || (filter.verdict && row.verdict !== filter.verdict)) continue
      totals.reviews += 1
      totals.verdicts[row.verdict] += 1
      totals.findings += row.findings
      totals.resolved += row.resolved
      totals.costUsd += row.costUsd ?? 0
      totals.severities.critical += row.severities.critical
      totals.severities.major += row.severities.major
      totals.severities.minor += row.severities.minor
      totals.severities.info += row.severities.info
    }
    cursor = heads.at(-1)?.createdAt ?? cursor
    if (exhausted) break
  }
  return exhausted ? totals : { ...totals, partial: true }
}

/** `GET /api/reviews/:id` of a review record and its parsed data. */
export function reviewDetail(
  record: Pick<AnalysisRecord, 'id' | 'repo' | 'createdAt'>,
  data: ReviewData,
): ReviewDetail {
  const review = reviewRowOf({ ...record, metrics: reviewMetrics(data) })
  if (!review) throw new Error('review metrics do not parse')
  return {
    review,
    summary: data.summary,
    head: data.head,
    sourceBranch: data.mergeRequest.sourceBranch,
    targetBranch: data.mergeRequest.targetBranch,
    findings: data.comments.map((finding) => ({
      id: finding.id,
      path: finding.path,
      line: finding.line,
      ...(finding.startLine ? { startLine: finding.startLine } : {}),
      severity: finding.severity,
      category: finding.category,
      title: finding.title,
      body: finding.body,
      source: finding.source,
      posted: finding.posted,
      ...(finding.error ? { error: finding.error } : {}),
      ...(finding.href ? { href: finding.href } : {}),
      ...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
    })),
    ...(data.usage
      ? {
          usage: {
            turns: data.usage.turns,
            ...(data.usage.inputTokens === undefined
              ? {}
              : { inputTokens: data.usage.inputTokens }),
            ...(data.usage.outputTokens === undefined
              ? {}
              : { outputTokens: data.usage.outputTokens }),
          },
        }
      : {}),
  }
}
