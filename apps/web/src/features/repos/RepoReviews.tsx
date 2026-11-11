import type { RepoRef, RepoReviewView } from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { ExternalLink, MessageSquareCode, ThumbsDown, ThumbsUp } from 'lucide-react'

import { useRepoReviews } from '../../api/queries.ts'
import { formatUsd } from '../../lib/ai-usage.ts'
import { formatDateTime, formatRelative, plural } from '../../lib/format.ts'
import { approvalShare } from '../../lib/repo-page.ts'
import type { StatusTone } from '../../ui/colors.ts'
import { EmptyState, ErrorState, Placeholder, Table, Tag, Td, Th } from '../../ui/index.ts'

const verdictTone: Record<RepoReviewView['verdict'], StatusTone> = {
  'looks-good': 'success',
  'needs-changes': 'warning',
  skipped: 'default',
}

const verdictLabel: Record<RepoReviewView['verdict'], string> = {
  'looks-good': 'looks good',
  'needs-changes': 'needs changes',
  skipped: 'skipped',
}

function Reactions({ up, down }: { up: number; down: number }) {
  if (!up && !down) return <span className="text-xs text-dim">—</span>
  return (
    <span className="mono inline-flex items-center gap-2 text-xs">
      <span className="inline-flex items-center gap-0.5 text-ok">
        <ThumbsUp className="size-3" aria-label="thumbs up" />
        {up}
      </span>
      <span className="inline-flex items-center gap-0.5 text-bad">
        <ThumbsDown className="size-3" aria-label="thumbs down" />
        {down}
      </span>
    </span>
  )
}

/** The repository's newest Holtkeeper reviews with verdict, comments, cost and reactions. */
export function RepoReviews({ repo }: { repo: RepoRef }) {
  const reviews = useRepoReviews(repo)
  if (reviews.isPending) return <Placeholder className="h-64" />
  if (reviews.isError) return <ErrorState error={reviews.error} />
  const { reviews: list, totals } = reviews.data
  if (!list.length)
    return (
      <EmptyState
        icon={<MessageSquareCode />}
        title="No reviews yet"
        description="Holtkeeper's merge request reviews of this repository show up here."
      />
    )
  const share = approvalShare(totals)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm text-muted">
        <span>
          Last {plural(list.length, 'review')}:{' '}
          <span className="mono text-foreground">{formatUsd(totals.costUsd)}</span>
        </span>
        <span>{plural(totals.posted, 'comment')} posted</span>
        <Reactions up={totals.up} down={totals.down} />
        {share !== undefined ? (
          <Tag tone={share >= 0.7 ? 'success' : share >= 0.4 ? 'warning' : 'danger'} mono>
            {Math.round(share * 100)}% 👍
          </Tag>
        ) : null}
      </div>
      <section className="rounded-xl border border-line bg-panel">
        <Table label="Reviews">
          <thead>
            <tr>
              <Th>Merge request</Th>
              <Th>Verdict</Th>
              <Th align="right">Comments</Th>
              <Th>Reactions</Th>
              <Th align="right">Cost</Th>
              <Th align="right">When</Th>
            </tr>
          </thead>
          <tbody>
            {list.map((review) => (
              <tr key={review.analysisId}>
                <Td>
                  <div className="flex min-w-0 items-center gap-2">
                    <a
                      href={review.mergeRequest.webUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mono shrink-0 text-xs text-muted hover:underline"
                    >
                      !{review.mergeRequest.iid}
                      <ExternalLink className="ml-0.5 inline size-3" />
                    </a>
                    <Link
                      to="/analyses/$id"
                      params={{ id: review.analysisId }}
                      className="min-w-0 truncate hover:underline"
                      title={review.mergeRequest.title}
                    >
                      {review.mergeRequest.title}
                    </Link>
                  </div>
                  <div className="text-xs text-dim">
                    {review.mergeRequest.author}
                    {review.mode === 'full' ? '' : ` · ${review.mode}`}
                  </div>
                </Td>
                <Td>
                  <Tag tone={verdictTone[review.verdict]} dot>
                    {verdictLabel[review.verdict]}
                  </Tag>
                </Td>
                <Td align="right" className="tabular text-xs">
                  {review.posted}
                  {review.resolved ? (
                    <span className="text-dim"> · {review.resolved} resolved</span>
                  ) : null}
                </Td>
                <Td>
                  <Reactions {...review.reactions} />
                </Td>
                <Td align="right" className="mono text-xs">
                  {review.costUsd !== undefined ? formatUsd(review.costUsd) : '—'}
                </Td>
                <Td align="right" className="text-xs text-muted">
                  <span title={formatDateTime(review.createdAt)}>
                    {formatRelative(review.createdAt)}
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>
    </div>
  )
}
