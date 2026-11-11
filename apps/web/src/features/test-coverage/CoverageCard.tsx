import type { CoverageRepoCard, RepoRef } from '@holtkeeper/api'
import { FlaskConical } from 'lucide-react'
import { useState } from 'react'

import { useRepoCoverage } from '../../api/queries.ts'
import {
  coverageFreshness,
  coverageTone,
  formatPercent,
  formatPoints,
  freshnessLabel,
  freshnessTone,
  lineSegments,
  percentOf,
  pointsTone,
  shortSha,
  trendTicks,
} from '../../lib/coverage.ts'
import { formatDateTime, formatRelative, plural } from '../../lib/format.ts'
import { splitRepoPath } from '../../lib/repo.ts'
import { statusColor } from '../../ui/colors.ts'
import { ErrorState, Placeholder, SegmentBar, Tag, TickStrip } from '../../ui/index.ts'
import { RunJobButton } from '../jobs/RunJobDialog.tsx'
import { RepoAvatar } from '../repos/RepoAvatar.tsx'
import { CoverageSheet } from './CoverageSheet.tsx'

/** One repository's newest coverage record; pressing it calls `onOpen`. */
export function CoverageCard({
  card,
  onOpen,
  showRepo = true,
}: {
  card: CoverageRepoCard
  onOpen: () => void
  /** Leave out the repository header, e.g. on the repository's own page. */
  showRepo?: boolean
}) {
  const { totals } = card
  const lines = percentOf(totals.lines)
  const branches = percentOf(totals.branches)
  const freshness = coverageFreshness(card)
  const change = formatPoints(card.change)
  const changed = card.changed ? percentOf(card.changed.lines) : undefined
  const { namespace, name } = splitRepoPath(card.repo.path)
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Coverage of ${card.repo.path}`}
      className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-3.5 text-left transition-colors hover:border-line-strong"
    >
      <header className="flex w-full items-start justify-between gap-2">
        {showRepo ? (
          <span className="flex min-w-0 items-center gap-2.5">
            <RepoAvatar repo={card.repo} size="sm" />
            <span className="min-w-0 truncate" title={card.repo.path}>
              <span className="text-muted">{namespace}</span>
              <span className="font-semibold">{name}</span>
            </span>
          </span>
        ) : (
          <span className="text-[13px] font-semibold">Test coverage</span>
        )}
        <Tag tone={freshnessTone[freshness]} dot>
          {freshnessLabel[freshness]}
        </Tag>
      </header>
      <div className="flex w-full flex-wrap items-baseline gap-x-2 gap-y-1">
        <span
          className="mono text-[15px] font-semibold"
          style={{ color: statusColor[coverageTone(lines)] }}
        >
          {formatPercent(lines)}
        </span>
        <span className="text-xs text-muted">lines</span>
        {change ? (
          <Tag tone={pointsTone(card.change)} mono title="Since the previous record">
            {change}
          </Tag>
        ) : null}
        {branches !== undefined ? (
          <span className="ml-auto text-xs text-muted">
            <span className="tabular" style={{ color: statusColor[coverageTone(branches)] }}>
              {formatPercent(branches)}
            </span>{' '}
            branches
          </span>
        ) : null}
      </div>
      <SegmentBar segments={lineSegments(totals)} />
      {card.trend.length > 1 ? (
        <TickStrip
          ticks={trendTicks(card.trend)}
          aria-label={`Line coverage of the last ${card.trend.length} records`}
          className="w-full"
        />
      ) : null}
      <div className="flex w-full flex-col gap-0.5 text-xs text-muted">
        {card.changed ? (
          <span>
            Changed files:{' '}
            <span className="tabular" style={{ color: statusColor[coverageTone(changed)] }}>
              {formatPercent(changed)}
            </span>{' '}
            of lines in {plural(card.changed.files, 'file')}
          </span>
        ) : null}
        <span>
          {plural(totals.files, 'file')}
          {totals.untested ? `, ${totals.untested} without tests` : ''}
        </span>
        <span title={formatDateTime(card.createdAt)}>
          {card.sha ? <span className="mono">{shortSha(card.sha)}</span> : 'Ran'}{' '}
          {formatRelative(card.createdAt)}
          {card.head ? (
            <>
              {' '}
              · HEAD <span className="mono">{shortSha(card.head)}</span>
            </>
          ) : null}
        </span>
      </div>
    </button>
  )
}

/**
 * A repository's coverage card that loads itself and opens the breakdown sheet, for the
 * repository's overview. Shows a prompt to run the analyzer until a record exists.
 */
export function RepoCoverageCard({ repo }: { repo: RepoRef }) {
  const coverage = useRepoCoverage(repo)
  const [open, setOpen] = useState(false)
  if (coverage.isPending) return <Placeholder className="h-40" />
  if (coverage.isError) return <ErrorState error={coverage.error} />
  const { card } = coverage.data
  if (!card)
    return (
      <div className="flex flex-col items-start gap-2 rounded-xl border border-dashed border-line p-3.5 text-sm text-muted">
        <span className="flex items-center gap-2">
          <FlaskConical className="size-4" />
          No coverage recorded yet
        </span>
        <RunJobButton repo={repo} analyzer="coverage" label="Run coverage" variant="secondary" />
      </div>
    )
  return (
    <>
      <CoverageCard card={card} showRepo={false} onOpen={() => setOpen(true)} />
      <CoverageSheet repo={open ? repo : undefined} onClose={() => setOpen(false)} />
    </>
  )
}
