import { mrkdwnLink } from '@holtkeeper/notify'
import { type ReviewData, reviewDataSchema, reviewMetrics, reviewRef } from '@holtkeeper/review'
import type { AnalysisStore, SlackReviewStatus } from '@holtkeeper/store'

/** The analysis kind review runs are stored under. */
const REVIEW_KIND = 'review'

/** Review records `latestReview` looks through, newest first. */
const REVIEW_SCAN = 100

const rank: Record<SlackReviewStatus, number> = {
  clean: 0,
  skipped: 1,
  minor: 2,
  reviewing: 3,
  changes: 4,
}

/**
 * The status a message about several merge requests shows: needs changes over an unfinished
 * review over minor findings over not reviewed over clean. `undefined` when none is known.
 */
export function worstStatus(
  statuses: Iterable<SlackReviewStatus | undefined>,
): SlackReviewStatus | undefined {
  let worst: SlackReviewStatus | undefined
  for (const status of statuses)
    if (status && (worst === undefined || rank[status] > rank[worst])) worst = status
  return worst
}

/**
 * What a finished review run says: `skipped` when it reviewed nothing, `changes` for
 * `needs-changes` or any posted major or critical finding, `minor` for other posted findings,
 * `clean` otherwise.
 */
export function reviewStatusOf(data: ReviewData): Exclude<SlackReviewStatus, 'reviewing'> {
  if (data.mode === 'skipped' || data.verdict === 'skipped') return 'skipped'
  const metrics = reviewMetrics(data)
  if (
    data.verdict === 'needs-changes' ||
    metrics.severities.major + metrics.severities.critical > 0
  )
    return 'changes'
  return metrics.comments > 0 ? 'minor' : 'clean'
}

/**
 * The newest stored review of a merge request that reviewed or skipped it (thread replies are
 * left out), among the repository's newest `REVIEW_SCAN` review records.
 */
export async function latestReview(
  analyses: Pick<AnalysisStore, 'list'>,
  repo: { forge: string; path: string },
  mergeRequest: number,
): Promise<ReviewData | undefined> {
  const records = await analyses.list({ repo, kind: REVIEW_KIND, limit: REVIEW_SCAN })
  for (const record of records) {
    if (record.ref !== reviewRef(mergeRequest)) continue
    const parsed = reviewDataSchema.safeParse(record.data)
    if (parsed.success && parsed.data.mode !== 'reply') return parsed.data
  }
  return undefined
}

const statusNames: Record<SlackReviewStatus, string> = {
  reviewing: 'Reviewing',
  clean: 'Clean',
  minor: 'Minor findings',
  changes: 'Needs changes',
  skipped: 'Not reviewed',
}

/** One merge request of a status reply. */
export interface StatusListEntry {
  /** Absent while no review is known. */
  status?: SlackReviewStatus
  url: string
  /** Link text, e.g. `widget!7 Add widget`. */
  label: string
}

/**
 * The mrkdwn text of a status reply: one line per entry, in order, with the status emoji from
 * `emoji`, the English status name and the link. An entry without a status has no emoji and
 * reads `Not reviewed`. The label shows as plain text.
 */
export function statusListText(
  entries: readonly StatusListEntry[],
  emoji: Readonly<Record<SlackReviewStatus, string>>,
): string {
  return entries
    .map(({ status, url, label }) => {
      const name = statusNames[status ?? 'skipped']
      const prefix = status ? `:${emoji[status]}: ` : ''
      return `${prefix}${name} — ${mrkdwnLink(url, label)}`
    })
    .join('\n')
}
