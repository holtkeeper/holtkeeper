import type {
  LearningCandidateView,
  ReviewDetail,
  ReviewFindingView,
  ReviewRow,
} from '@holtkeeper/api'
import { Link } from '@tanstack/react-router'
import { ExternalLink, RotateCcw } from 'lucide-react'
import { useState } from 'react'

import { useLearnings, useReview } from '../../api/queries.ts'
import { formatUsd } from '../../lib/ai-usage.ts'
import { formatDuration, formatRelative, shortSha } from '../../lib/format.ts'
import { repoKey, repoSplat } from '../../lib/repo.ts'
import {
  type ReviewSheetTab,
  modeLabel,
  reviewSeverityLabel,
  reviewSeverityTone,
  severitySegments,
  tokenText,
  verdictLabel,
  verdictTone,
} from '../../lib/reviews.ts'
import { httpUrl } from '../../lib/url.ts'
import { Dot, ErrorState, KeyValue, Markdown, Placeholder, SideSheet, Tag } from '../../ui/index.ts'
import { ReviewAgainDialog, useCanReview } from './ReviewDialogs.tsx'

const lines = (text: string | undefined, sign: string) =>
  text === undefined ? [] : text.split('\n').map((line) => `${sign} ${line}`)

function Suggestion({ suggestion }: { suggestion: NonNullable<ReviewFindingView['suggestion']> }) {
  return (
    <pre className="mono m-0 overflow-x-auto rounded-md border border-line bg-sunk py-1.5 text-[11.5px] leading-relaxed">
      {lines(suggestion.original, '-').map((line, index) => (
        <span key={`d${index}`} className="block whitespace-pre px-2.5 text-bad">
          {line}
        </span>
      ))}
      {lines(suggestion.replacement, '+').map((line, index) => (
        <span key={`a${index}`} className="block whitespace-pre px-2.5 text-ok">
          {line}
        </span>
      ))}
    </pre>
  )
}

function Finding({ finding }: { finding: ReviewFindingView }) {
  const where = `${finding.path}:${finding.startLine && finding.startLine !== finding.line ? `${finding.startLine}-` : ''}${finding.line}`
  return (
    <article className="flex flex-col overflow-hidden rounded-[10px] border border-line">
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-sunk px-3 py-2">
        {finding.href ? (
          <a
            href={finding.href}
            target="_blank"
            rel="noreferrer"
            className="mono min-w-0 truncate text-xs hover:underline"
          >
            {where}
          </a>
        ) : (
          <span className="mono min-w-0 truncate text-xs">{where}</span>
        )}
        <span className="flex-1" />
        <Tag>{finding.category}</Tag>
        <span className="inline-flex items-center gap-1.5 text-xs">
          <Dot tone={reviewSeverityTone[finding.severity]} />
          {reviewSeverityLabel[finding.severity]}
        </span>
      </header>
      <div className="flex flex-col gap-2 px-3 py-2.5 text-[12.5px]">
        <p className="m-0 font-medium">{finding.title}</p>
        {finding.body ? <Markdown text={finding.body} className="text-[12.5px]" /> : null}
        {finding.suggestion ? <Suggestion suggestion={finding.suggestion} /> : null}
      </div>
      <footer className="flex flex-wrap items-center gap-2.5 border-t border-line px-3 py-1.5 text-xs text-muted">
        {finding.posted ? (
          <Tag tone="success" dot>
            Posted
          </Tag>
        ) : (
          <Tag tone="danger" dot>
            Not posted
          </Tag>
        )}
        {finding.error ? <span className="min-w-0 truncate">{finding.error}</span> : null}
        <span className="flex-1" />
        <span>{finding.source === 'agent' ? 'Agent' : finding.source}</span>
      </footer>
    </article>
  )
}

function RunFacts({ detail }: { detail: ReviewDetail }) {
  const { review } = detail
  const tokens = detail.usage ? tokenText(detail.usage) : undefined
  return (
    <section className="flex flex-col gap-2.5 border-t border-line pt-3.5">
      <h3 className="m-0 text-[11.5px] font-medium text-muted">Review</h3>
      <KeyValue
        rows={[
          { label: 'Mode', value: modeLabel[review.mode] },
          {
            label: 'Commit',
            value: detail.head ? <span className="mono">{shortSha(detail.head)}</span> : null,
          },
          {
            label: 'Model',
            value: review.model ? <span className="mono">{review.model}</span> : '—',
          },
          { label: 'Tokens', value: tokens ? <span className="mono">{tokens}</span> : null },
          {
            label: 'Cost',
            value: (
              <>
                <span className="mono">
                  {review.costUsd === undefined ? '—' : formatUsd(review.costUsd)}
                </span>
                {review.durationMs !== undefined ? (
                  <span className="text-muted">· {formatDuration(review.durationMs)}</span>
                ) : null}
              </>
            ),
          },
          {
            label: 'Guide used',
            value: review.guideScopes.length ? (
              <Link to="/knowledge/guide" className="hover:underline">
                {review.guideScopes.join(' › ')}
              </Link>
            ) : (
              <span className="text-muted">None</span>
            ),
          },
          {
            label: 'Record',
            value: (
              <>
                <Link
                  to="/analyses/$id"
                  params={{ id: review.analysisId }}
                  className="hover:underline"
                >
                  Analysis record
                </Link>
                <span className="text-muted">{formatRelative(review.createdAt)}</span>
              </>
            ),
          },
        ]}
      />
    </section>
  )
}

function ReviewLearnings({
  repo,
  candidates,
}: {
  repo: ReviewRow['repo']
  candidates: readonly LearningCandidateView[]
}) {
  const link = { to: '/knowledge/learnings', search: { space: `repo:${repoKey(repo)}` } } as const
  if (!candidates.length)
    return (
      <p className="text-xs text-muted">
        No reply to this review became a learning candidate.{' '}
        <Link {...link} className="text-foreground hover:underline">
          Learnings of the repository
        </Link>
      </p>
    )
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col divide-y divide-line rounded-[10px] border border-line">
        {candidates.map((candidate) => (
          <li key={candidate.id} className="flex items-start gap-2 px-3 py-2 text-[12.5px]">
            <span className="min-w-0 flex-1">{candidate.rule}</span>
            <Tag
              tone={
                candidate.status === 'accepted'
                  ? 'success'
                  : candidate.status === 'rejected'
                    ? 'default'
                    : 'warning'
              }
            >
              {candidate.status}
            </Tag>
          </li>
        ))}
      </ul>
      <Link {...link} className="self-start text-xs text-muted hover:text-foreground">
        Decide in Knowledge › Learnings
      </Link>
    </div>
  )
}

function ReviewBody({ detail, tab }: { detail: ReviewDetail; tab: ReviewSheetTab }) {
  return (
    <div className="flex flex-col gap-3.5">
      {tab === 'summary' ? (
        detail.summary ? (
          <Markdown text={detail.summary} className="text-[12.5px]" />
        ) : (
          <p className="text-xs text-muted">The run left no summary.</p>
        )
      ) : detail.findings.length ? (
        <div className="flex flex-col gap-2.5">
          {detail.findings.map((finding) => (
            <Finding key={finding.id} finding={finding} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted">No findings: nothing worth a comment.</p>
      )}
      <RunFacts detail={detail} />
    </div>
  )
}

/**
 * One review run in the side sheet: verdict, severities, findings with suggestions, summary and
 * the run's model, tokens, cost, duration and guide scopes. "Review again" needs `useCanReview`.
 */
export function ReviewSheet({
  row,
  tab,
  onTab,
  onClose,
  index,
  total,
  onPrevious,
  onNext,
}: {
  row: ReviewRow | undefined
  tab: ReviewSheetTab | undefined
  onTab: (tab: ReviewSheetTab) => void
  onClose: () => void
  index?: number
  total?: number
  onPrevious?: () => void
  onNext?: () => void
}) {
  const detail = useReview(row?.analysisId)
  const learnings = useLearnings(row ? { repo: row.repo } : {}, row !== undefined)
  const canReview = useCanReview()
  const [isAgain, setAgain] = useState(false)
  if (!row) return null
  const current = tab ?? 'findings'
  const candidates = (learnings.data?.candidates ?? []).filter((candidate) =>
    candidate.sources.some(
      (source) => source.repo === repoKey(row.repo) && source.mergeRequest === row.mergeRequest.iid,
    ),
  )
  const url = httpUrl(row.mergeRequest.url)
  const open = url
    ? {
        label: 'Open merge request',
        icon: ExternalLink,
        onPress: () => window.open(url, '_blank', 'noopener,noreferrer'),
      }
    : undefined
  const again = canReview
    ? { label: 'Review again', icon: RotateCcw, onPress: () => setAgain(true) }
    : undefined
  const quiet = [open, again].filter((action) => action !== undefined)
  return (
    <>
      <SideSheet
        size="wide"
        open
        onClose={onClose}
        id={`!${row.mergeRequest.iid}`}
        copyId={row.mergeRequest.url}
        title={row.mergeRequest.title}
        {...(index !== undefined && total !== undefined ? { index, total } : {})}
        {...(onPrevious ? { onPrevious } : {})}
        {...(onNext ? { onNext } : {})}
        openAsPage={{ to: '/analyses/$id', params: { id: row.analysisId } }}
        progress={{
          segments: severitySegments(row.severities),
          label: `${row.findings} finding${row.findings === 1 ? '' : 's'}`,
        }}
        {...(quiet[0] ? { quietActions: quiet[1] ? [quiet[0], quiet[1]] : [quiet[0]] } : {})}
        tabs={{
          items: [
            { id: 'findings', label: 'Findings', badge: row.findings },
            { id: 'summary', label: 'Summary' },
            {
              id: 'learnings',
              label: 'Learnings',
              ...(candidates.length ? { badge: candidates.length } : {}),
            },
          ],
          selected: current,
          onSelect: (id) => onTab(id === 'summary' || id === 'learnings' ? id : 'findings'),
          'aria-label': 'Review details',
        }}
      >
        <div className="flex flex-col gap-3.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <Tag tone={verdictTone[row.verdict]} dot>
              {verdictLabel[row.verdict]}
            </Tag>
            <Link
              to="/repos/$"
              params={{ _splat: repoSplat(row.repo) }}
              search={{ tab: 'quality', section: 'reviews' }}
              className="mono hover:text-foreground"
            >
              {row.repo.path}
            </Link>
            {detail.data ? (
              <>
                <span className="text-dim">·</span>
                <span className="mono">
                  {detail.data.sourceBranch} → {detail.data.targetBranch}
                </span>
              </>
            ) : null}
            {row.mergeRequest.author ? (
              <>
                <span className="text-dim">·</span>
                <span>{row.mergeRequest.author}</span>
              </>
            ) : null}
          </div>
          {current === 'learnings' ? (
            learnings.isPending ? (
              <Placeholder className="h-32" />
            ) : learnings.isError ? (
              <ErrorState error={learnings.error} />
            ) : (
              <ReviewLearnings repo={row.repo} candidates={candidates} />
            )
          ) : detail.isPending ? (
            <Placeholder className="h-64" />
          ) : detail.isError ? (
            <ErrorState error={detail.error} />
          ) : (
            <ReviewBody detail={detail.data} tab={current} />
          )}
        </div>
      </SideSheet>
      <ReviewAgainDialog
        isOpen={isAgain}
        onOpenChange={setAgain}
        repo={row.repo}
        mergeRequest={row.mergeRequest}
      />
    </>
  )
}
