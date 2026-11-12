import type { CreateJobInput, RepoRef, ReviewFindingCounts, ReviewRow } from '@holtkeeper/api'

import { repoKey } from './repo.ts'
import { searchEntry, searchEnum, searchText } from './search-params.ts'
import { type SortState, type SortValue, sortRows } from './table-sort.ts'

/** Verdicts of a review run, in display order. */
export const reviewVerdicts = [
  'looks-good',
  'needs-changes',
  'skipped',
] as const satisfies readonly ReviewRow['verdict'][]

/** Modes of a review run, in display order. */
export const reviewModes = [
  'full',
  'incremental',
  'reply',
  'skipped',
] as const satisfies readonly ReviewRow['mode'][]

/** Periods (days) Quality › Reviews looks back over; 30 is the server's default. */
export const reviewPeriods = [7, 30, 90] as const

/** Days Quality › Reviews looks back over. */
export type ReviewPeriod = (typeof reviewPeriods)[number]

const reviewSheetTabs = ['findings', 'summary', 'learnings'] as const

/** A tab of the review sheet. */
export type ReviewSheetTab = (typeof reviewSheetTabs)[number]

/** Columns Quality › Reviews sorts by. */
export type ReviewSortKey = 'when' | 'findings' | 'cost'

/**
 * Search parameters of Quality › Reviews: `repo` (`forge:path`) picks one repository; `q`,
 * `verdict`, `mode`, `author` and `days` filter the rows; `review` opens a run in the sheet on its
 * `tab`.
 */
export interface ReviewsSearch {
  repo?: string
  q?: string
  verdict?: ReviewRow['verdict']
  mode?: ReviewRow['mode']
  author?: string
  days?: ReviewPeriod
  review?: string
  tab?: ReviewSheetTab
}

const period = (value: unknown): ReviewPeriod | undefined => {
  const days = typeof value === 'string' ? Number(value) : value
  return reviewPeriods.find((option) => option === days)
}

/** `ReviewsSearch` from raw search values; unknown and empty values are dropped. */
export const parseReviewsSearch = (search: Record<string, unknown>): ReviewsSearch => ({
  ...searchEntry('repo', searchText(search.repo)),
  ...searchEntry('q', searchText(search.q)),
  ...searchEntry('verdict', searchEnum(search.verdict, reviewVerdicts)),
  ...searchEntry('mode', searchEnum(search.mode, reviewModes)),
  ...searchEntry('author', searchText(search.author)),
  ...searchEntry('days', period(search.days)),
  ...searchEntry('review', searchText(search.review)),
  ...searchEntry('tab', searchEnum(search.tab, reviewSheetTabs)),
})

/** Verdicts in words. */
export const verdictLabel: Record<ReviewRow['verdict'], string> = {
  'looks-good': 'Looks good',
  'needs-changes': 'Needs changes',
  skipped: 'Skipped',
}

/** Status tone of a verdict. */
export const verdictTone: Record<ReviewRow['verdict'], 'success' | 'warning' | 'default'> = {
  'looks-good': 'success',
  'needs-changes': 'warning',
  skipped: 'default',
}

/** Modes in words. */
export const modeLabel: Record<ReviewRow['mode'], string> = {
  full: 'Full review',
  incremental: 'Incremental',
  reply: 'Reply to a thread',
  skipped: 'Skipped',
}

const reviewSeverities = [
  'critical',
  'major',
  'minor',
  'info',
] as const satisfies readonly (keyof ReviewFindingCounts)[]

/** Review finding severities in words. */
export const reviewSeverityLabel: Record<keyof ReviewFindingCounts, string> = {
  critical: 'Critical',
  major: 'Major',
  minor: 'Minor',
  info: 'Info',
}

/** Status tone of a review finding severity. */
export const reviewSeverityTone: Record<
  keyof ReviewFindingCounts,
  'danger' | 'warning' | 'info' | 'default'
> = {
  critical: 'danger',
  major: 'warning',
  minor: 'info',
  info: 'default',
}

/** Segments of a severity bar, worst first, each labelled in words. */
export const severitySegments = (counts: ReviewFindingCounts) =>
  reviewSeverities.map((severity) => ({
    value: counts[severity],
    tone: reviewSeverityTone[severity],
    label: reviewSeverityLabel[severity].toLowerCase(),
  }))

/** "2 critical · 1 major", worst first, leaving out empty severities; empty without findings. */
export const severityText = (counts: ReviewFindingCounts): string =>
  reviewSeverities
    .filter((severity) => counts[severity] > 0)
    .map((severity) => `${counts[severity]} ${reviewSeverityLabel[severity].toLowerCase()}`)
    .join(' · ')

/** The `since` of `GET /api/reviews` for `days`; `undefined` keeps the server's 30 days. */
export const reviewSince = (days: ReviewPeriod | undefined, now: Date = new Date()) =>
  days === undefined || days === 30
    ? undefined
    : new Date(now.getTime() - days * 86_400_000).toISOString()

/**
 * Rows matching the filters the server does not apply: `q` against the merge request number,
 * title, author and repository path (case-insensitive), `mode` and `author`.
 */
export function filterReviews(
  rows: readonly ReviewRow[],
  filter: Pick<ReviewsSearch, 'q' | 'mode' | 'author'>,
): ReviewRow[] {
  const needle = filter.q?.trim().toLowerCase().replace(/^!/, '')
  return rows.filter((row) => {
    if (filter.mode && row.mode !== filter.mode) return false
    if (filter.author && row.mergeRequest.author !== filter.author) return false
    if (!needle) return true
    return [
      String(row.mergeRequest.iid),
      row.mergeRequest.title,
      row.mergeRequest.author ?? '',
      row.repo.path,
    ].some((text) => text.toLowerCase().includes(needle))
  })
}

/** Distinct merge request authors of `rows`, alphabetically. */
export const reviewAuthors = (rows: readonly ReviewRow[]): string[] =>
  [
    ...new Set(rows.flatMap((row) => (row.mergeRequest.author ? [row.mergeRequest.author] : []))),
  ].toSorted((a, b) => a.localeCompare(b))

const sortValue = (row: ReviewRow, key: ReviewSortKey): SortValue =>
  key === 'when' ? row.createdAt : key === 'findings' ? row.findings : row.costUsd

/** `rows` sorted by a column; without a sort they keep the server's newest-first order. */
export const sortReviews = (rows: readonly ReviewRow[], sort: SortState<ReviewSortKey>) =>
  sortRows(rows, sort, sortValue)

/** Sums over review rows, for the summary strip. */
export interface ReviewTotals {
  reviews: number
  verdicts: Record<ReviewRow['verdict'], number>
  findings: number
  severities: ReviewFindingCounts
  resolved: number
  costUsd: number
}

/** Sums over `rows`; rows without a cost add nothing to it. */
export function reviewTotals(rows: readonly ReviewRow[]): ReviewTotals {
  const totals: ReviewTotals = {
    reviews: rows.length,
    verdicts: { 'looks-good': 0, 'needs-changes': 0, skipped: 0 },
    findings: 0,
    severities: { critical: 0, major: 0, minor: 0, info: 0 },
    resolved: 0,
    costUsd: 0,
  }
  for (const row of rows) {
    totals.verdicts[row.verdict] += 1
    totals.findings += row.findings
    totals.resolved += row.resolved
    totals.costUsd += row.costUsd ?? 0
    for (const severity of reviewSeverities) totals.severities[severity] += row.severities[severity]
  }
  return totals
}

/**
 * The merge request number in what a person typed: `12`, `!12`, `#12`, or a merge request or
 * pull request URL. `undefined` when there is none.
 */
export function mergeRequestNumber(input: string): number | undefined {
  const text = input.trim()
  const match =
    /^[!#]?(\d+)$/.exec(text) ?? /\/(?:merge_requests|pulls?)\/(\d+)(?:[/?#]|$)/.exec(text)
  const number = match ? Number(match[1]) : NaN
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}

/**
 * The job that reviews merge request `mergeRequest` of `repo`; `force` reviews it again even when
 * its head was reviewed already.
 */
export const reviewJobInput = (
  repo: RepoRef,
  mergeRequest: number,
  force = false,
): CreateJobInput => ({
  analyzer: 'review',
  repo: repoKey(repo),
  options: { mergeRequest, ...(force ? { force: true } : {}) },
})

const tokens = (count: number) =>
  count >= 1_000_000
    ? `${(count / 1_000_000).toFixed(1)}M`
    : count >= 1000
      ? `${Math.round(count / 1000)}k`
      : String(count)

/** "96k in · 8k out · 3 turns" from a run's usage; parts it lacks are left out. */
export const tokenText = (usage: { inputTokens?: number; outputTokens?: number; turns: number }) =>
  [
    usage.inputTokens !== undefined ? `${tokens(usage.inputTokens)} in` : undefined,
    usage.outputTokens !== undefined ? `${tokens(usage.outputTokens)} out` : undefined,
    usage.turns ? `${usage.turns} turn${usage.turns === 1 ? '' : 's'}` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(' · ')
