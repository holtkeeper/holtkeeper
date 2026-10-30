import type { MergeRequestRecord } from '@holtkeeper/forge'

import { bucketize, byTime, distribution, round, secondsBetween, within } from './stats.ts'
import type { MergeRequestFlow, StaleMergeRequest } from './types.ts'

const HOUR = 3600
const DAY = 24 * HOUR

const AGE_BUCKETS = [
  { label: '< 1 day', below: DAY },
  { label: '1–7 days', below: 7 * DAY },
  { label: '7–30 days', below: 30 * DAY },
  { label: '> 30 days', below: Infinity },
]

const MERGE_BUCKETS = [
  { label: '< 1 hour', below: HOUR },
  { label: '1–24 hours', below: DAY },
  { label: '1–7 days', below: 7 * DAY },
  { label: '> 7 days', below: Infinity },
]

/** Open merge requests by age, stale ones (idle longest first) and how fast merges happen. */
export function computeFlow(input: {
  from: string
  to: string
  mergeRequests: MergeRequestRecord[]
  staleDays: number
}): MergeRequestFlow {
  const { from, to, staleDays } = input
  const open = input.mergeRequests.filter((mr) => mr.state === 'open')
  const stale: StaleMergeRequest[] = open
    .map((mr) => ({
      id: mr.id,
      title: mr.title,
      author: mr.author,
      webUrl: mr.webUrl,
      draft: mr.draft,
      labels: mr.labels,
      createdAt: mr.createdAt,
      updatedAt: mr.updatedAt,
      ageDays: round(secondsBetween(mr.createdAt, to) / DAY, 1),
      idleDays: round(secondsBetween(mr.updatedAt, to) / DAY, 1),
    }))
    .filter((mr) => mr.idleDays >= staleDays)
    .toSorted((a, b) => byTime(a.updatedAt, b.updatedAt) || a.id - b.id)

  const merged = input.mergeRequests.filter(
    (mr) => mr.state === 'merged' && within(mr.mergedAt, from, to),
  )
  const mergeTimes = merged.map((mr) => secondsBetween(mr.createdAt, mr.mergedAt ?? mr.updatedAt))
  const sizes = merged.map((mr) => mr.changesCount).filter((n) => n !== undefined)

  return {
    open: open.length,
    drafts: open.filter((mr) => mr.draft).length,
    openByAge: bucketize(
      open.map((mr) => secondsBetween(mr.createdAt, to)),
      AGE_BUCKETS,
    ),
    stale,
    merged: merged.length,
    timeToMerge: { ...distribution(mergeTimes), buckets: bucketize(mergeTimes, MERGE_BUCKETS) },
    ...(sizes.length > 0 ? { size: distribution(sizes) } : {}),
  }
}
