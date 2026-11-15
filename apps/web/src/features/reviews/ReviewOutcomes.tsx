import type { RepoRef } from '@holtkeeper/api'

import { useReviewQuality } from '../../api/queries.ts'
import { repoKey } from '../../lib/repo.ts'
import {
  type ReviewsSearch,
  acceptanceTone,
  outcomeGroups,
  outcomePeriods,
  outcomeSegments,
  outcomeSince,
  shareText,
} from '../../lib/reviews.ts'
import { FilterButton, Legend, SegmentBar, Tag } from '../../ui/index.ts'

const COLUMNS = 'grid grid-cols-[minmax(7rem,1fr)_3.5rem_minmax(8rem,2fr)_4.5rem_4.5rem] gap-x-3'

const groupOptions = outcomeGroups.map(({ id, label }) => ({ id, label }))
const periodOptions = outcomePeriods.map((days) => ({
  id: String(days),
  label: `Last ${days} days`,
}))

/**
 * What became of Holtkeeper's review comments on merged merge requests
 * (`GET /api/reviews/quality`): per category, severity, model, prompt version or source, how many
 * ended in changed code (fixed), only a resolved thread, or nothing (ignored). Accepted is
 * fixed over judged comments, addressed adds the resolved ones. Renders nothing for callers the
 * server refuses.
 */
export function ReviewOutcomes({
  repo,
  search,
  update,
}: {
  repo?: RepoRef
  search: Pick<ReviewsSearch, 'by' | 'outcomes'>
  update: (patch: Partial<ReviewsSearch>) => void
}) {
  const by = search.by ?? 'category'
  const days = search.outcomes ?? 90
  const quality = useReviewQuality({
    by,
    since: outcomeSince(days),
    ...(repo ? { repo: repoKey(repo) } : {}),
  })
  if (quality.isError || !quality.data) return null
  const { rows, total } = quality.data
  const label = outcomeGroups.find((group) => group.id === by)?.label ?? by
  return (
    <section
      aria-label="What happened to the review comments"
      className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-3.5"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h2 className="text-[13px] font-semibold">
          What happened to the comments
          <small className="ml-2 text-xs font-normal text-muted">on merged merge requests</small>
        </h2>
        {total.acceptance !== undefined ? (
          <Tag tone={acceptanceTone(total.acceptance)}>{shareText(total.acceptance)} accepted</Tag>
        ) : null}
        <span className="flex-1" />
        <FilterButton
          label="Group by"
          single
          all="Category"
          options={groupOptions}
          value={[by]}
          onChange={(ids) => {
            const next = outcomeGroups.find((group) => group.id === ids.at(-1))?.id
            update({ by: next === 'category' ? undefined : next })
          }}
        />
        <FilterButton
          label="Period"
          single
          all="Last 90 days"
          options={periodOptions}
          value={days === 90 ? [] : [String(days)]}
          onChange={(ids) => {
            const next = outcomePeriods.find((period) => String(period) === ids.at(-1))
            update({ outcomes: next === 90 ? undefined : next })
          }}
        />
      </div>
      {total.comments === 0 ? (
        <p className="text-xs text-muted">
          No judged comments in this period. Outcomes are recorded when a merge request is merged.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className={`${COLUMNS} text-[11px] font-medium uppercase tracking-wide text-dim`}>
            <span>{label}</span>
            <span className="text-right">Comments</span>
            <span>Outcome</span>
            <span
              className="text-right"
              title="Comments whose lines changed afterwards, of those judged"
            >
              Accepted
            </span>
            <span
              className="text-right"
              title="Comments whose lines changed or whose thread was resolved, of those judged"
            >
              Addressed
            </span>
          </div>
          {[...rows, { ...total, key: '' }].map((row) => (
            <div
              key={row.key || 'all'}
              className={`${COLUMNS} items-center ${row.key ? '' : 'border-t border-line pt-2 font-medium'}`}
            >
              <span className="mono truncate text-xs">{row.key || 'All'}</span>
              <span className="mono text-right text-xs">{row.comments}</span>
              <SegmentBar segments={outcomeSegments(row)} />
              <span className="mono text-right text-xs">{shareText(row.acceptance)}</span>
              <span className="mono text-right text-xs text-muted">{shareText(row.addressed)}</span>
            </div>
          ))}
        </div>
      )}
      <Legend
        label="Outcomes"
        items={[
          { label: 'fixed', tone: 'success' },
          { label: 'resolved', tone: 'info' },
          { label: 'ignored', tone: 'warning' },
          { label: 'unknown', tone: 'default' },
        ]}
      />
    </section>
  )
}
